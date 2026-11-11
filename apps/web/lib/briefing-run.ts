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
import { BRIEFING_RULES, checkContent, extractJson, maskContent, maskFigures, type BriefContent, type BriefRef } from "@nichols/briefing/domain";
import type { BrainPromptContext } from "@nichols/brain/server";
import { loadBriefing, type BriefingView } from "./briefing";

type Db = Parameters<typeof loadBriefing>[0];

export type RunDeps = {
  client: Db;
  provider: LLMProvider;
  /** Live body of one message (the caller's own guarded reader). Throws when unreadable. */
  readBody: (laneId: LaneId, connectionId: string, messageId: string) => Promise<string>;
  brain: BrainPromptContext | null;
  /** lane_policies: what may go to the model (llm_allowed_categories); outbound drafts may be stored. */
  policy: BriefingPolicy;
  save: (laneId: LaneId, record: SavedBriefing) => Promise<string>;
  /** Creates one email.send proposal (T-231d) and returns its id. Absent: drafts stay on Home only. Throws a coded error. */
  proposeReply?: (laneId: LaneId, reply: ReplyProposal) => Promise<string>;
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
const reSubject = (s: string | null) => {
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
  for (const d of content.replies) {
    if (MASKED.test(d.text)) d.status = "awaiting_input";
    const r = byRef.get(d.ref);
    const to = r?.fromAddress?.toLowerCase() ?? null;
    if (!r || !d.text || !to || !r.threadKey || r.threadKey.startsWith("m:") || to === r.mailbox?.toLowerCase()) {
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
      });
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
export async function runBriefing(deps: RunDeps, input: { laneId: LaneId; ownerUserId: string; trigger: "manual" | "schedule"; now: Date; viewerTz: string }): Promise<{ id: string; status: SavedBriefing["status"] }> {
  const { laneId, now } = input;
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
  const coverage = view.coverage.map((c) => ({ stream: c.stream, account: c.account, state: c.state }));
  const sourceRefs = refs.map((r) => ({ ...r, subject: r.subject ? maskFigures(r.subject) : null }));
  const base = { ownerUserId: input.ownerUserId, trigger: input.trigger, ...window, coverage, sourceRefs };
  const empty = (extra: string[]): BriefContent => ({ lines: [], attention: [], deadlines: [], priorities: [], replies: [], moreReplies: [], notes: [...notes, ...extra] });
  if (!policy.email && !policy.calendar) {
    // Nothing may go to the model for this lane: no call. Home keeps the rule-based sections.
    const id = await deps.save(laneId, { ...base, status: "partial", content: empty(["model_not_allowed"]), model: null });
    return { id, status: "partial" };
  }

  let content: BriefContent;
  let model: string | null = deps.provider.modelFor("analysis");
  try {
    const res = await deps.provider.complete({ laneId, tier: "analysis", system: prompt.system, messages: withUserContext([{ role: "user", content: user }], prompt.userContext), maxTokens: 3000 });
    model = res.model;
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (res.status !== "completed") throw new Error(`model ${res.status}`);
    const raw = extractJson(text);
    if (raw === null) throw new Error("model output is not JSON");
    content = maskContent(checkContent(raw, refs, sourcesFor, allSources, { replies: policy.storeDrafts }));
    if (!policy.storeDrafts) notes.push("reply_drafts_off");
  } catch (e) {
    console.error("[briefing] model step failed", { laneId, error: e instanceof Error ? e.name : typeof e });
    const id = await deps.save(laneId, { ...base, status: "failed", content: empty(["model_failed"]), model });
    return { id, status: "failed" };
  }
  content.notes = [...notes, ...content.notes];
  if (policy.storeDrafts) await proposeReplies(deps, laneId, content, refs);
  const partial = view.coverage.some((c) => c.state !== "ok") || notes.some((n) => n.startsWith("body_unreadable")) || !view.mail.access || content.notes.includes("lines_ungrounded");
  const status = partial ? "partial" : "ready";
  const id = await deps.save(laneId, { ...base, status, content, model });
  return { id, status };
}
