// Reply from the dashboard (T-234 part 3), server side. Three things, all for the OWNER, all through the user's own lane client
// and the approvals module (rule 5: nothing here writes to Gmail; "Send" is propose/edit + the approvals route's approve):
//   replyContext  read-only: what the drawer shows. The thread, the sending mailbox, the subject and the default recipient are
//                 re-derived here from mail METADATA (core.inbox_message_ref under RLS) on every call; the client supplies a
//                 message id and nothing else. A pending email.send for that message (the T-231d draft, or an earlier save) is
//                 loaded; the thread text is read live, truncated, plain, untrusted, never stored (rules 6 and 9).
//   draftReply    the on-demand AI draft, only when no proposal exists: lane policy gate ("email" category), rate limit, the
//                 one thread read live and wrapped as untrusted data, the same checks as the briefing's drafts (grounding,
//                 foreign links and addresses, masking). The draft is returned, never stored (D-19).
//   saveReply     create or update the email.send proposal with exactly the edited To, Cc and Body. The subject is "Re: ..." from
//                 metadata and never changes; the client's thread, subject and mailbox are never read.
// Errors are fixed codes; never row text, provider text or a prompt.
import { wrapUntrusted, UNTRUSTED_DATA_RULE, type LLMProvider } from "@nichols/ai";
import {
  ApprovalsError,
  capabilityOf,
  editEmailProposal,
  listApprovals,
  proposeEmailAction,
  type ActionRow,
  type ApprovalsPublicDeps,
  type CapabilityFacts,
  type UserCtx,
} from "@nichols/approvals/server";
import { checkContent, extractJson, maskContent, maskFigures, type BriefRef } from "@nichols/briefing/domain";
import type { LaneClient } from "@nichols/core/lane-router";
import { displayText, isMessageId } from "./inbox";
import { reSubject } from "./briefing-run";
import { isOutcomeUnknown } from "./outcome";
import { REPLY_MESSAGES, type ReplyErrorCode } from "./reply-messages";

export { REPLY_ERROR_CODES, REPLY_MESSAGES, type ReplyErrorCode } from "./reply-messages";

export class ReplyError extends Error {
  override readonly name = "ReplyError";
  readonly code: ReplyErrorCode;
  constructor(code: ReplyErrorCode) {
    super(REPLY_MESSAGES[code]);
    this.code = code;
  }
}

type Db = Pick<LaneClient, "schema">;

export type ReplyDeps = {
  /** The one message's text, live, through the caller's own guarded reader (the same one the thread view uses). */
  readBody: (laneId: string, connectionId: string, messageId: string) => Promise<{ text: string; truncated: boolean }>;
  /** The AI provider (the mock in tests). */
  llm: () => { configured: true; provider: LLMProvider } | { configured: false };
  /** true = allowed. At most one draft per thread per user per minute. */
  limiter: { take: (key: string) => boolean };
  now: () => number;
};

// ---------------------------------------------------------------------------------------------------------- limiter

/** In-memory, per process: at most `max` takes per key in `windowMs`. (Per instance on serverless: a second instance has its own count; the model call is also bounded by the provider's own limits.) */
export function createLimiter(opts: { windowMs: number; max: number; now?: () => number }): { take: (key: string) => boolean } {
  const hits = new Map<string, number[]>();
  const now = opts.now ?? Date.now;
  return {
    take(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < opts.windowMs);
      if (recent.length >= opts.max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      // Bound the map: drop keys with nothing recent.
      if (hits.size > 2000) for (const [k, v] of hits) if (v.every((x) => t - x >= opts.windowMs)) hits.delete(k);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------- metadata

export type MessageRef = {
  messageId: string;
  connectionId: string;
  threadId: string;
  fromName: string | null;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: string;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/**
 * The message's metadata under RLS (the user's own client): a message the user may not see, in another lane, or malformed is
 * `not_found`. Only Gmail messages that belong to a real Gmail thread can be replied to.
 */
export async function loadMessageRef(ctx: UserCtx, messageId: string): Promise<MessageRef> {
  if (!isMessageId(messageId)) throw new ApprovalsError("not_found");
  const { data, error } = await ctx.rpc("inbox_message_ref", { p_lane: ctx.laneId, p_message_id: messageId });
  if (error) throw new ApprovalsError("unavailable");
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row || typeof row.connection_id !== "string" || row.provider !== "google") throw new ApprovalsError("not_found");
  const threadId = str(row.thread_id);
  if (!threadId || threadId.startsWith("m:")) throw new ReplyError("not_replyable");
  return {
    messageId,
    connectionId: row.connection_id,
    threadId,
    fromName: str(row.from_name),
    fromAddress: str(row.from_address),
    subject: str(row.subject),
    receivedAt: typeof row.received_at === "string" ? row.received_at : "",
  };
}

/** "Re: <subject>" from metadata: one line, at most 998 characters (the proposal's own limit). */
export const replySubject = (subject: string | null): string => reSubject(subject === null ? null : displayText(subject)).slice(0, 990);

export type ReplyPolicy = { aiEmail: boolean; storesDrafts: boolean };

/** lane_policies under RLS. Unreadable -> nothing allowed (fail closed). */
export async function readReplyPolicy(db: Db, laneId: string): Promise<ReplyPolicy> {
  try {
    const r = await db.schema("core").from("lane_policies").select("llm_allowed_categories, store_outbound_drafts").eq("lane_id", laneId).maybeSingle();
    if (r.error || !r.data) return { aiEmail: false, storesDrafts: false };
    const d = r.data as { llm_allowed_categories?: unknown; store_outbound_drafts?: unknown };
    return { aiEmail: Array.isArray(d.llm_allowed_categories) && d.llm_allowed_categories.includes("email"), storesDrafts: d.store_outbound_drafts === true };
  } catch {
    return { aiEmail: false, storesDrafts: false };
  }
}

const addressOf = (v: string | null): string | null => (v && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(v) ? v.toLowerCase() : null);

/** Default recipient: the sender, unless that is one of the lane's own mailboxes (then empty: the owner types it). */
export function defaultRecipients(ref: MessageRef, ownMailboxes: readonly string[]): string[] {
  const from = addressOf(ref.fromAddress);
  if (!from) return [];
  return ownMailboxes.map((m) => m.toLowerCase()).includes(from) ? [] : [from];
}

// ---------------------------------------------------------------------------------------------------------- existing proposals

const replyTargetOf = (r: ActionRow): string | null => {
  const rep = r.payload.inReplyTo;
  return typeof rep === "object" && rep !== null && typeof (rep as { messageId?: unknown }).messageId === "string" ? (rep as { messageId: string }).messageId : null;
};
const DAY_MS = 86_400_000;

/** The pending email.send for this message (newest first from act_list) and whether an earlier send may have gone out. */
export function findReplyState(rows: readonly ActionRow[], ref: MessageRef, now: number): { proposal: ActionRow | null; blocked: boolean } {
  const mine = rows.filter((r) => r.actionType === "email.send" && r.connectionId === ref.connectionId && replyTargetOf(r) === ref.messageId);
  const proposal = mine.find((r) => r.status === "proposed" && Date.parse(r.expiresAt) > now && r.payloadPurgedAt === null && typeof r.payload.bodyText === "string") ?? null;
  // Approved or executing = in flight; failed with a code after which the email may exist = unknown. Never offer a blind second send (T-192).
  const blocked = mine.some((r) => r.status === "approved" || r.status === "executing" || (r.status === "failed" && isOutcomeUnknown(r.failureCode) && now - Date.parse(r.updatedAt) < DAY_MS));
  return { proposal, blocked };
}

// ---------------------------------------------------------------------------------------------------------- context

export const PREVIEW_CHARS = 2000;

export type ReplyContext = {
  messageId: string;
  /** "Sends as": the connection's mailbox. */
  mailbox: string;
  /** The fixed subject. */
  subject: string;
  /** Plain-text sender line for "Replying to". */
  replyingTo: string;
  defaults: { to: string[]; cc: string[] };
  /** Domains of the lane's mailboxes: a recipient outside them is flagged "Outside your company". */
  internalDomains: string[];
  proposal: null | {
    id: string;
    hash: string;
    to: string[];
    cc: string[];
    bcc: string[];
    bodyText: string;
    origin: "briefing" | "owner";
    derivedFromRetrieved: boolean;
    rationale: string | null;
  };
  /** Can this mailbox send now (the T-232 capability); the message is the exact NOT_ENABLED / NOT_LIVE text. */
  send: { enabled: boolean; message: string | null; settingsHref: string | null };
  storesDrafts: boolean;
  aiAllowed: boolean;
  /** An earlier send may have gone out: Send and Save are off until the owner has checked the Sent folder. */
  blocked: boolean;
  /** The start of the message replied to: plain text, untrusted, not stored. Null when it could not be read. */
  preview: { text: string; truncated: boolean } | null;
};

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function replyContext(ctx: UserCtx, db: Db, approvals: ApprovalsPublicDeps, deps: ReplyDeps, messageId: string): Promise<ReplyContext> {
  const ref = await loadMessageRef(ctx, messageId);
  const [facts, policy, rows, own] = await Promise.all([
    approvals.readFacts(ctx.laneId, ref.connectionId),
    readReplyPolicy(db, ctx.laneId),
    listApprovals(approvals, ctx, 100),
    approvals.laneMailboxes(ctx.laneId).catch(() => [] as string[]),
  ]);
  if (facts.mailbox === null) throw new ApprovalsError("not_found");
  const { proposal, blocked } = findReplyState(rows, ref, deps.now());
  const cap = capabilityOf(ctx.laneId, facts, "email.send");
  let preview: ReplyContext["preview"] = null;
  try {
    const b = await deps.readBody(ctx.laneId, ref.connectionId, ref.messageId);
    const text = displayText(b.text);
    preview = { text: text.slice(0, PREVIEW_CHARS), truncated: b.truncated || text.length > PREVIEW_CHARS };
  } catch {
    preview = null; // the drawer still works without it
  }
  return {
    messageId: ref.messageId,
    mailbox: facts.mailbox,
    subject: proposal && typeof proposal.payload.subject === "string" ? proposal.payload.subject : replySubject(ref.subject),
    replyingTo: displayText(ref.fromName && ref.fromAddress ? `${ref.fromName} <${ref.fromAddress}>` : (ref.fromAddress ?? ref.fromName ?? "Unknown sender")),
    defaults: { to: defaultRecipients(ref, own), cc: [] },
    internalDomains: [...new Set([...own, facts.mailbox].map((m) => m.split("@")[1] ?? "").filter((d) => d !== ""))],
    proposal: proposal
      ? {
          id: proposal.id,
          hash: proposal.payloadSha256,
          to: strs(proposal.payload.to),
          cc: strs(proposal.payload.cc),
          bcc: strs(proposal.payload.bcc),
          bodyText: String(proposal.payload.bodyText),
          origin: proposal.proposerKind === "job" ? "briefing" : "owner",
          derivedFromRetrieved: proposal.derivedFromRetrieved,
          rationale: proposal.rationale,
        }
      : null,
    send: { enabled: cap.enabled, message: cap.message, settingsHref: cap.settingsHref },
    storesDrafts: policy.storesDrafts,
    aiAllowed: policy.aiEmail,
    blocked,
    preview,
  };
}

// ---------------------------------------------------------------------------------------------------------- save (propose or edit)

export type SaveInput = { messageId: string; to: readonly string[]; cc: readonly string[]; bodyText: string };

/**
 * Creates the owner's email.send proposal for this message, or edits the pending one (supersede when the content changed, the
 * same id when it did not). Returns the id and the hash of exactly what was saved: approve with that hash.
 */
export async function saveReply(ctx: UserCtx, db: Db, approvals: ApprovalsPublicDeps, deps: Pick<ReplyDeps, "now">, input: SaveInput): Promise<{ id: string; hash: string; unchanged: boolean }> {
  const ref = await loadMessageRef(ctx, input.messageId);
  const policy = await readReplyPolicy(db, ctx.laneId);
  if (!policy.storesDrafts) throw new ApprovalsError("drafts_not_allowed");
  const rows = await listApprovals(approvals, ctx, 100);
  const { proposal, blocked } = findReplyState(rows, ref, deps.now());
  if (blocked) throw new ReplyError("check_sent_first");
  if (proposal) {
    // The subject, thread, mailbox and bcc stay as stored: only what the owner may edit goes in.
    return editEmailProposal(approvals, ctx, proposal.id, { to: [...input.to], cc: [...input.cc], bodyText: input.bodyText });
  }
  const own = await approvals.laneMailboxes(ctx.laneId).catch(() => [] as string[]);
  const sameAsDefault = JSON.stringify(input.to.map((a) => a.toLowerCase())) === JSON.stringify(defaultRecipients(ref, own));
  const r = await proposeEmailAction(approvals, ctx.laneId, {
    actionType: "email.send",
    connectionId: ref.connectionId,
    compose: { to: [...input.to], cc: [...input.cc], bcc: [], subject: replySubject(ref.subject), bodyText: input.bodyText, inReplyTo: { threadId: ref.threadId, messageId: ref.messageId } },
    sourceRefs: [{ kind: "message", id: ref.messageId }],
    proposerKind: "user",
    proposerUserId: ctx.userId,
    // The recipient came from the email unless the owner typed another.
    derivedFromRetrieved: sameAsDefault,
  });
  return { id: r.id, hash: r.hash, unchanged: false };
}

// ---------------------------------------------------------------------------------------------------------- AI draft

const MAX_BODY_CHARS = 4000;
const DRAFT_RULES = [
  "You draft a short, polite, plain-text reply for the mailbox owner, who reads and edits it before anything is sent.",
  "Write only the reply body: no subject line, no quoted original. Do not invent facts.",
  "Never state an amount, price, percentage, date, deadline or commitment that is not written in the message; if the reply would need one, leave it out.",
  "Do not include links or email addresses unless they appear in the message.",
  'Answer with JSON only: {"text":"the reply body"}.',
].join(" ");

export type DraftResult = { status: "ready" | "awaiting_input"; text: string };

const MASKED = /\[(?:amount|number)\]/;

/** Pure: the model's JSON -> the checked draft (grounding, foreign links and addresses, masking). A masked figure means the owner types it. */
export function checkDraft(raw: unknown, ref: BriefRef, sources: string[]): DraftResult {
  const text = typeof raw === "object" && raw !== null && typeof (raw as { text?: unknown }).text === "string" ? (raw as { text: string }).text : null;
  if (text === null) throw new ReplyError("ai_failed");
  const checked = maskContent(checkContent({ replies: [{ ref: ref.ref, status: "ready", context: "", text }] }, [ref], () => sources, sources, { replies: true }));
  const d = checked.replies[0];
  if (!d || d.status !== "ready" || d.text === "" || MASKED.test(d.text)) return { status: "awaiting_input", text: "" };
  return { status: "ready", text: d.text };
}

/** The on-demand draft. Never stored here; the owner saves or sends it from the drawer. */
export async function draftReply(ctx: UserCtx, db: Db, approvals: ApprovalsPublicDeps, deps: ReplyDeps, messageId: string): Promise<DraftResult> {
  const ref = await loadMessageRef(ctx, messageId);
  const policy = await readReplyPolicy(db, ctx.laneId);
  if (!policy.aiEmail) throw new ReplyError("ai_not_allowed");
  const llm = deps.llm();
  if (!llm.configured) throw new ReplyError("ai_not_configured");
  if (!deps.limiter.take(`${ctx.laneId}:${ctx.userId}:${ref.threadId}`)) throw new ReplyError("rate_limited");
  let body: string;
  try {
    body = (await deps.readBody(ctx.laneId, ref.connectionId, ref.messageId)).text.slice(0, MAX_BODY_CHARS);
  } catch {
    throw new ReplyError("body_unavailable");
  }
  const facts: CapabilityFacts = await approvals.readFacts(ctx.laneId, ref.connectionId);
  const briefRef: BriefRef = {
    ref: "r1",
    connectionId: ref.connectionId,
    messageId: ref.messageId,
    threadKey: ref.threadId,
    mailbox: facts.mailbox,
    fromAddress: ref.fromAddress,
    fromName: ref.fromName,
    subject: ref.subject,
    receivedAt: ref.receivedAt,
    sourceUrl: null,
    reason: "reply",
    kind: "reply",
  };
  const metaLine = wrapUntrusted(`from ${ref.fromName ?? ""} <${ref.fromAddress ?? "unknown"}>, subject "${ref.subject ? maskFigures(ref.subject).replace(/\s+/g, " ") : ""}"`, { source: "email-metadata", id: "r1" });
  const meta = `from ${ref.fromName ?? ""} <${ref.fromAddress ?? "unknown"}>, subject "${ref.subject ? maskFigures(ref.subject).replace(/\s+/g, " ") : ""}"`;
  try {
    const res = await llm.provider.complete({
      laneId: ctx.laneId,
      tier: "analysis",
      signal: AbortSignal.timeout(50_000),
      system: [DRAFT_RULES, UNTRUSTED_DATA_RULE].join("\n\n"),
      messages: [{ role: "user", content: `Message to reply to (untrusted data):\n${metaLine}\n${wrapUntrusted(body, { source: "email", id: "r1" })}\n\nWrite the reply JSON now.` }],
      maxTokens: 1200,
    });
    if (res.status !== "completed") throw new ReplyError("ai_failed");
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const raw = extractJson(text);
    if (raw === null) throw new ReplyError("ai_failed");
    return checkDraft(raw, briefRef, [meta, body]);
  } catch (e) {
    if (e instanceof ReplyError) throw e;
    // The class only: never a provider message, the prompt or the message text.
    console.error("[reply] draft failed", { laneId: ctx.laneId, error: e instanceof Error ? e.name : typeof e });
    throw new ReplyError("ai_failed");
  }
}
