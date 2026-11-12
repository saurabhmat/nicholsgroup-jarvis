// The AI daily briefing run (T-231c, T-231d). One run = one lane, one owner:
//   1. the rule-based sections (lib/briefing.loadBriefing) with the given client (the owner's own lane client for "Run
//      now", the job client for the schedule);
//   2. the lane policy decides what reaches the model (llm_allowed_categories): mail facts (metadata and the top threads'
//      latest messages, read LIVE, never stored, rule 6) only with "email", calendar facts only with "calendar", no model
//      call with neither. Everything a sender or invitee wrote (subjects, names, titles, bodies) goes in wrapped as
//      untrusted data (rule 9); subjects are masked first;
//   3. one model call with the owner's brain profile (About-Me, Preferences, lane pages) and BRIEFING_RULES;
//   4. the JSON checked (known refs only, grounding: no invented figures or dates -> "Awaiting your input"), then every
//      model string masked (amounts, long numbers: rule 7);
//   5. reply drafts (kept only when the lane policy stores outbound drafts, D-19) become email.send PROPOSALS in the
//      Approval Center (T-231d, T-232): recipient, subject, thread and sending mailbox come from the stored metadata, never
//      from the model; only the body text is the model's. Proposing never sends; the owner edits and approves there;
//   6. saved to brief.briefings with coverage, source refs, the review window and each draft's proposal id.
// Nothing here sends, saves to Gmail or approves anything.
import { wrapUntrusted, UNTRUSTED_DATA_RULE, type LLMProvider } from "@nichols/ai";
import { assemblePrompt, BRAIN_RULES, withUserContext } from "@nichols/ai/prompts";
import type { LaneId } from "@nichols/core";
import { BRIEFING_RULES, checkContent, classifyFailure, failureNote, maskContent, maskFigures, type BriefContent, type BriefRef, type FailureCode } from "@nichols/briefing/domain";
import type { BrainPromptContext } from "@nichols/brain/server";
import { loadBriefing, type BriefingView } from "./briefing";
import { BRIEFING_OUTPUT_SCHEMA, correctionMessage, parseBriefingOutput } from "./briefing-output";

type Db = Parameters<typeof loadBriefing>[0];

export type RunDeps = {
  client: Db;
  provider: LLMProvider;
  /** Live body of one message (the caller's own guarded reader). Throws when unreadable. */
  readBody: (laneId: LaneId, connectionId: string, messageId: string) => Promise<string>;
  /** Aborted at the run's time bound: every write (save, proposals) and read checks it first (T-234 review H1). */
  signal?: AbortSignal;
  /** Told the review window as soon as it is known, so the timeout fallback row can use the same one. */
  onWindow?: (w: { windowFrom: string; windowTo: string }) => void;
  brain: BrainPromptContext | null;
  /** Milliseconds clock (tests only); default Date.now. Used for the retry budget. */
  clock?: () => number;
  /** lane_policies: what may go to the model (llm_allowed_categories); outbound drafts may be stored. */
  policy: BriefingPolicy;
  save: (laneId: LaneId, record: SavedBriefing) => Promise<string>;
  /** Creates one email.send proposal (T-231d) and returns its id. Absent: drafts stay on Home only. Throws a coded error. */
  proposeReply?: (laneId: LaneId, reply: ReplyProposal, signal?: AbortSignal) => Promise<string>;
};

/** What the briefing hands to the Approval Center: everything but `bodyText` and `rationale` is mail metadata. */
export type ReplyProposal = {
  connectionId: string;
  to: string[];
  subject: string;
  bodyText: string;
  inReplyTo: { threadId: string; messageId: string };
  rationale: string;
  sourceRefs: { kind: "message"; id: string }[];
};

const MASKED = /\[(?:amount|number)\]/;
const NO_REPLY = /^(?:no-?reply|do-?not-?reply|mailer-daemon|notifications?)[@+.]/i;
export const reSubject = (s: string | null) => {
  const t = (s ?? "").replace(/[\r\n]+/g, " ").trim();
  return /^re:/i.test(t) ? t : `Re: ${t}`.trim();
};

/**
 * Turns the checked drafts into proposals. A draft is proposed only when its thread is a real provider thread, the
 * sender is known and is not the lane mailbox itself. A masked figure in the text means the owner must fill it in:
 * the draft becomes "Awaiting your input". A failure never stops the briefing; it leaves a code in the notes.
 */
async function proposeReplies(deps: RunDeps, laneId: LaneId, content: BriefContent, refs: readonly BriefRef[]): Promise<void> {
  if (!deps.proposeReply) return;
  const byRef = new Map(refs.map((r) => [r.ref, r]));
  const ownMailboxes = new Set(refs.flatMap((r) => (r.mailbox ? [r.mailbox.toLowerCase()] : [])));
  for (const d of content.replies) {
    const r = byRef.get(d.ref);
    const to = r?.fromAddress?.toLowerCase() ?? null;
    // A masked figure means the owner must fill it in: the draft stays on Home ("Awaiting your input", Copy) and is
    // never proposed, so "[amount]" can never be approved and sent as written (T-231d code review H1).
    if (MASKED.test(d.text)) {
      d.status = "awaiting_input";
      content.notes.push(`reply_not_proposed:${d.ref}`);
      continue;
    }
    // Only a draft checked as ready is proposed (T-231d security review M1): "Awaiting your input" stays on Home.
    if (d.status !== "ready" || !r || !d.text || !to || !r.threadKey || r.threadKey.startsWith("m:") || ownMailboxes.has(to) || NO_REPLY.test(to)) {
      content.notes.push(`reply_not_proposed:${d.ref}`);
      continue;
    }
    try {
      d.proposalId = await deps.proposeReply(laneId, {
        connectionId: r.connectionId,
        to: [to],
        subject: reSubject(r.subject),
        bodyText: d.text,
        inReplyTo: { threadId: r.threadKey, messageId: r.messageId },
        rationale: d.context,
        sourceRefs: [{ kind: "message", id: r.messageId }],
      }, deps.signal);
    } catch (e) {
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "unavailable";
      content.notes.push(`reply_proposal_${code === "already_proposed" ? "exists" : "failed"}:${d.ref}`);
      if (code !== "already_proposed") console.error("[briefing] reply proposal failed", { laneId, code });
    }
  }
}

export type SavedBriefing = {
  ownerUserId: string;
  trigger: "manual" | "schedule";
  status: "ready" | "partial" | "failed";
  windowFrom: string;
  windowTo: string;
  content: BriefContent;
  coverage: { stream: string; account: string; state: string }[];
  sourceRefs: BriefRef[];
  model: string | null;
};

/** Thrown inside the model step so classifyFailure can tell "the reply was unusable" from a provider failure. */
export class BriefingOutputError extends Error {
  constructor() {
    super("briefing output unusable");
    this.name = "BriefingOutputError";
  }
}
/** The reply stopped at the output limit (stopReason max_tokens) on its last allowed attempt: never parsed (T-236). */
export class BriefingTruncatedError extends Error {
  constructor() {
    super("briefing output cut off");
    this.name = "BriefingTruncatedError";
  }
}
/** The output limit of the one retry after a cut-off reply: 1.5x briefing.max_tokens, at most 32000. */
export const retryMaxTokens = (maxTokens: number): number => Math.min(32_000, Math.ceil(maxTokens * 1.5));
const SHORTER =
  "Your previous reply was cut off at the length limit and could not be used. Write the complete briefing JSON again, shorter: at most 3 lines, 3 priorities and 3 reply drafts, each draft a few sentences. One JSON object only.";

export class BriefingTimeoutError extends Error {
  constructor() {
    super("briefing timed out");
    this.name = "BriefingTimeoutError";
  }
}

export type BriefingPolicy = { email: boolean; calendar: boolean; storeDrafts: boolean };

/** The lane_policies row -> what the briefing may send to the model. Missing or unreadable -> nothing (fail closed). */
export function policyFrom(row: { llm_allowed_categories?: unknown; store_outbound_drafts?: unknown } | null | undefined): BriefingPolicy {
  const cats = Array.isArray(row?.llm_allowed_categories) ? (row.llm_allowed_categories as unknown[]) : [];
  return { email: cats.includes("email"), calendar: cats.includes("calendar"), storeDrafts: row?.store_outbound_drafts === true };
}

const MAX_BODY_CHARS = 4000;
const MAX_REFS = 8;
const DAY_MS = 86_400_000;

/** The refs given to the model: attention first, then money threads not already in it. */
export function refsFrom(view: BriefingView): BriefRef[] {
  if (!view.mail.access) return [];
  const out: BriefRef[] = [];
  const seen = new Set<string>();
  const mailboxOf = view.mail.mailboxOf;
  const push = (t: (typeof view.mail.attention)[number]["thread"], reason: string, kind: string) => {
    const key = `${t.connectionId}:${t.threadKey}`;
    if (seen.has(key) || out.length >= MAX_REFS) return;
    seen.add(key);
    out.push({
      ref: `r${String(out.length + 1)}`,
      connectionId: t.connectionId,
      messageId: t.messageId,
      threadKey: t.threadKey,
      mailbox: mailboxOf[t.connectionId] ?? null,
      fromAddress: t.fromAddress,
      fromName: t.fromName,
      subject: t.subject,
      receivedAt: t.receivedAt,
      sourceUrl: t.sourceUrl,
      reason,
      kind,
    });
  };
  for (const a of view.mail.attention) if (a.kind !== "repeated_failures") push(a.thread, a.reason, a.kind);
  for (const m of view.mail.money) push(m.thread, m.kind.replace("_", " "), `money:${m.kind}`);
  return out;
}

/** One ref for the model: the ref id and rule reason are ours; everything sender-written is wrapped as untrusted data. */
const metaLine = (r: BriefRef) =>
  `${r.ref}: ${r.kind} | received ${r.receivedAt} | rule: ${r.reason} | ` +
  wrapUntrusted(`from ${r.fromName ?? ""} <${r.fromAddress ?? "unknown"}> to mailbox ${r.mailbox ?? "unknown"}, subject "${r.subject ? maskFigures(r.subject).replace(/\s+/g, " ") : ""}"`, { source: "email-metadata", id: r.ref });

function factsText(view: BriefingView, refs: BriefRef[], now: Date, policy: BriefingPolicy): string {
  const cal = !policy.calendar
    ? ["Calendar: not shared with the AI for this company."]
    : view.calendar.access
      ? [
          "Today's calendar:",
          ...view.calendar.today.map((e, i) => `- ${e.allDay ? "all day" : `${e.startAt}–${e.endAt}`} ${wrapUntrusted(e.title, { source: "calendar", id: `today${String(i + 1)}` })}${e.rsvpPending ? " (RSVP pending)" : ""}${e.clashesWith.length ? ` (clashes with ${wrapUntrusted(e.clashesWith.join(", "), { source: "calendar", id: `clash${String(i + 1)}` })})` : ""}`),
          "Next 7 days (notable):",
          ...view.calendar.ahead.map((e, i) => `- ${e.startAt} ${wrapUntrusted(e.title, { source: "calendar", id: `ahead${String(i + 1)}` })} (${e.why.join(", ")})`),
        ]
      : ["Calendar: not available."];
  const mail = policy.email ? ["Mail items needing attention (metadata):", ...refs.map(metaLine)] : ["Mail: not shared with the AI for this company."];
  return [`Now: ${now.toISOString()} (owner's zone ${view.viewerTz}).`, view.coverageLine, ...cal, ...mail].join("\n");
}

/** Runs one briefing and saves it. Returns the saved id and the content. */
export async function runBriefing(deps: RunDeps, input: { laneId: LaneId; ownerUserId: string; trigger: "manual" | "schedule"; now: Date; viewerTz: string }): Promise<{ id: string; status: SavedBriefing["status"]; reason?: FailureCode }> {
  const { laneId, now } = input;
  const clock = deps.clock ?? Date.now;
  const runStartedMs = clock();
  const view = await loadBriefing(deps.client, laneId, now, input.viewerTz);
  const { policy } = deps;
  // Without "email" the model gets no mail at all, so no refs either (nothing to attach notes or drafts to).
  const refs = policy.email ? refsFrom(view) : [];
  const notes: string[] = [];
  const bodies = new Map<string, string>();
  if (!policy.email) notes.push("email_not_allowed");
  if (!policy.calendar) notes.push("calendar_not_allowed");
  if (policy.email) {
    await Promise.all(
      refs.slice(0, 5).map(async (r) => {
        try {
          bodies.set(r.ref, (await deps.readBody(laneId, r.connectionId, r.messageId)).slice(0, MAX_BODY_CHARS));
        } catch {
          notes.push(`body_unreadable:${r.ref}`);
        }
      }),
    );
  }
  notes.sort(); // body reads finish in any order
  const facts = factsText(view, refs, now, policy);
  const untrusted = [...bodies].map(([ref, text]) => wrapUntrusted(text, { source: "email", id: ref })).join("\n");
  const sourcesFor = (ref: string) => {
    const r = refs.find((x) => x.ref === ref);
    return r ? [metaLine(r), bodies.get(ref) ?? ""] : [];
  };
  const allSources = [facts, ...bodies.values()];

  const prompt = assemblePrompt({
    laneIds: [laneId],
    now,
    categories: [...(policy.email ? ["email"] : []), ...(policy.calendar ? ["calendar"] : [])],
    subjectUserId: input.ownerUserId,
    brainUser: deps.brain?.brainUser ?? null,
    laneBrain: deps.brain ? Object.fromEntries(Object.entries(deps.brain.laneBrain).filter(([l]) => l === laneId)) : {},
    rules: [BRIEFING_RULES, BRAIN_RULES, UNTRUSTED_DATA_RULE].join("\n\n"),
    brainNotes: deps.brain?.notes ?? ["no_brain"],
  });
  const user = [facts, untrusted ? `Messages (untrusted data):\n${untrusted}` : "No message bodies were read.", "Write the briefing JSON now."].join("\n\n");
  const window = { windowFrom: new Date(now.getTime() - view.config.attention_days * DAY_MS).toISOString(), windowTo: now.toISOString() };
  deps.onWindow?.(window);
  const coverage = view.coverage.map((c) => ({ stream: c.stream, account: c.account, state: c.state }));
  const sourceRefs = refs.map((r) => ({ ...r, subject: r.subject ? maskFigures(r.subject) : null }));
  const base = { ownerUserId: input.ownerUserId, trigger: input.trigger, ...window, coverage, sourceRefs };
  const empty = (extra: string[]): BriefContent => ({ lines: [], attention: [], deadlines: [], priorities: [], replies: [], moreReplies: [], notes: [...notes, ...extra] });
  if (!policy.email && !policy.calendar) {
    // Nothing may go to the model for this lane: no call. Home keeps the rule-based sections.
    const id = await deps.save(laneId, { ...base, status: "partial", content: empty(["model_not_allowed", failureNote("model_not_allowed")]), model: null });
    return { id, status: "partial", reason: "model_not_allowed" };
  }

  let content: BriefContent;
  let model: string | null = deps.provider.modelFor("analysis");
  try {
    const messages = withUserContext([{ role: "user", content: user }], prompt.userContext);
    const limit = view.config.max_tokens;
    let attempt = 0;
    const ask = async (msgs: typeof messages, maxTokens: number, short = false) => {
      // The retry after a cut-off reply runs at effort "low": less thinking, so it fits the output limit and the time bound.
      const res = await deps.provider.complete({ laneId, tier: "analysis", ...(deps.signal ? { signal: deps.signal } : {}), system: prompt.system, messages: msgs, maxTokens, outputSchema: BRIEFING_OUTPUT_SCHEMA, ...(short ? { effort: "low" as const } : {}) });
      model = res.model;
      // Codes and counts only (never content).
      console.info("[briefing] briefing.model_call", { laneId, attempt: ++attempt, stopReason: res.stopReason, outputTokens: res.usage.outputTokens, maxTokens });
      // A reply cut off at the output limit is never parsed (it would be half a JSON object). A context-window stop is not
      // fixed by a higher output limit: no retry, the usual "could not be read" code (review L3).
      if (res.status === "max_tokens") throw res.stopReason === "max_tokens" ? new BriefingTruncatedError() : new BriefingOutputError();
      if (res.status !== "completed") throw new BriefingOutputError();
      return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    };
    let text: string;
    let retried = false;
    try {
      text = await ask(messages, limit);
    } catch (e) {
      if (!(e instanceof BriefingTruncatedError)) throw e;
      // One retry with 1.5x the limit and a request for a shorter briefing, only while it can still finish inside the bound.
      if (clock() - runStartedMs > RETRY_ONLY_BEFORE_MS) {
        console.error("[briefing] briefing.retry_skipped", { laneId, elapsedMs: clock() - runStartedMs });
        throw e;
      }
      retried = true;
      // Two user turns in a row: the API merges consecutive same-role turns (covered by the opt-in contract test).
      text = await ask([...messages, { role: "user", content: SHORTER }], retryMaxTokens(limit), true);
    }
    let parsed = parseBriefingOutput(text);
    if (!parsed.ok) {
      // Codes only (schema paths and Zod issue codes): never a value, a prompt or the reply.
      console.error("[briefing] briefing.model_output_invalid", { laneId, attempt, issues: parsed.issues });
      // The retry only when it can still finish inside the run's bound; otherwise fail now with the usual code.
      // One retry in all: none after a retry for a cut-off reply, and none once it could not finish inside the run's bound.
      if (retried || clock() - runStartedMs > RETRY_ONLY_BEFORE_MS) {
        if (!retried) console.error("[briefing] briefing.retry_skipped", { laneId, elapsedMs: clock() - runStartedMs });
        throw new BriefingOutputError();
      }
      // One retry: the previous reply and the validation problems (no new email content).
      const retry: typeof messages = [...messages, ...(text.trim() ? [{ role: "assistant" as const, content: text }] : []), { role: "user", content: correctionMessage(parsed.issues) }];
      text = await ask(retry, limit);
      parsed = parseBriefingOutput(text);
      if (!parsed.ok) {
        console.error("[briefing] briefing.model_output_invalid", { laneId, attempt: 2, issues: parsed.issues });
        throw new BriefingOutputError();
      }
    }
    const raw: unknown = parsed.value;
    content = maskContent(checkContent(raw, refs, sourcesFor, allSources, { replies: policy.storeDrafts }));
    if (!policy.storeDrafts) notes.push("reply_drafts_off");
  } catch (e) {
    // Class name and the fixed reason code only: never a provider message, a value or a prompt.
    const reason = classifyFailure(e);
    console.error("[briefing] model step failed", { laneId, error: e instanceof Error ? e.name : typeof e, reason });
    const id = await deps.save(laneId, { ...base, status: "failed", content: empty(["model_failed", failureNote(reason)]), model });
    return { id, status: "failed", reason };
  }
  content.notes = [...notes, ...content.notes];
  if (policy.storeDrafts) await proposeReplies(deps, laneId, content, refs);
  const partial = view.coverage.some((c) => c.state !== "ok") || notes.some((n) => n.startsWith("body_unreadable")) || !view.mail.access || content.notes.includes("lines_ungrounded");
  const status = partial ? "partial" : "ready";
  const id = await deps.save(laneId, { ...base, status, content, model });
  return { id, status };
}

// ---------------------------------------------------------------- bounded, single-flight run (T-234 part 0; background since T-235)

/** Bound for a background run (the abort timer starts before the brain context loads): well under Home's maxDuration (90 s). */
export const BACKGROUND_RUN_TIMEOUT_MS = 60_000;
/** No retry of an unusable reply once this much of the run has elapsed: the retry could not finish inside the bound. */
export const RETRY_ONLY_BEFORE_MS = 40_000;

const inFlight = new Map<string, symbol>();

/**
 * Runs one briefing with a time bound and at most one run per lane and owner in this process. A second call while one is
 * running returns `busy` without calling the model. At the bound an AbortController fires: the model call and Gmail reads
 * stop, and every write (save, reply proposals) refuses with BriefingTimeoutError, so a late run can create nothing. A
 * failed attempt with reason "timeout" is recorded and the caller gets `reason: "timeout"`. The single-flight key is freed
 * only when the underlying run has settled. Across processes the SQL lock and 2-minute cooldown in core.briefing_save_own
 * keep a second concurrent save out ("too_soon").
 * Known and accepted: a save already in flight at the cutoff may succeed although "timeout" is reported (harmless).
 */
export async function runBriefingBounded(
  deps: RunDeps,
  input: Parameters<typeof runBriefing>[1],
  opts: { timeoutMs?: number } = {},
): Promise<Awaited<ReturnType<typeof runBriefing>> | { busy: true }> {
  const key = `${input.laneId}:${input.ownerUserId}`;
  if (inFlight.has(key)) return { busy: true };
  const token = Symbol(key);
  inFlight.set(key, token);
  const release = () => {
    if (inFlight.get(key) === token) inFlight.delete(key); // never frees a newer run's key
  };
  const controller = new AbortController();
  const live = () => {
    if (controller.signal.aborted) throw new BriefingTimeoutError();
  };
  let window: { windowFrom: string; windowTo: string } | null = null;
  const propose = deps.proposeReply;
  const guarded: RunDeps = {
    ...deps,
    signal: controller.signal,
    onWindow: (w) => {
      window = w;
      deps.onWindow?.(w);
    },
    readBody: async (l, c, m) => {
      live();
      const text = await deps.readBody(l, c, m);
      live();
      return text;
    },
    save: async (l, r) => {
      live();
      return deps.save(l, r);
    },
    ...(propose
      ? {
          proposeReply: async (l: LaneId, r: ReplyProposal) => {
            live();
            return propose(l, r, controller.signal);
          },
        }
      : {}),
  };
  const run = runBriefing(guarded, input);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  // Freed when the run settles, or at a hard ceiling (2 x the bound) if it never does, whichever comes first.
  const ceiling = setTimeout(release, 2 * (opts.timeoutMs ?? BACKGROUND_RUN_TIMEOUT_MS));
  ceiling.unref?.();
  void settled.finally(() => {
    clearTimeout(ceiling);
    release();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const limit = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), opts.timeoutMs ?? BACKGROUND_RUN_TIMEOUT_MS);
    });
    const first = await Promise.race([run, limit]);
    if (first !== "timeout") return first;
    controller.abort();
    console.error("[briefing] run timed out", { laneId: input.laneId, reason: "timeout" });
    const empty: BriefContent = { lines: [], attention: [], deadlines: [], priorities: [], replies: [], moreReplies: [], notes: ["model_failed", failureNote("timeout")] };
    const w = (window as { windowFrom: string; windowTo: string } | null) ?? { windowFrom: new Date(input.now.getTime() - DAY_MS).toISOString(), windowTo: input.now.toISOString() };
    try {
      const id = await deps.save(input.laneId, { ownerUserId: input.ownerUserId, trigger: input.trigger, status: "failed", ...w, content: empty, coverage: [], sourceRefs: [], model: null });
      return { id, status: "failed", reason: "timeout" };
    } catch {
      return { id: "", status: "failed", reason: "timeout" };
    }
  } finally {
    clearTimeout(timer);
  }
}
