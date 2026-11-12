// Approvals page data and API (T-232). Logic lives here so it is testable without Next: the page loader builds plain view
// models (pending cards with their capability, recent history), and `handleApprovals` is the POST handler:
//   same-origin JSON, bounded body -> body schema -> AAL2 session + OWNER role in the lane -> (approve only) a TOTP step-up
//   within the lane's step_up_max_age_s -> the approvals module (which re-checks everything in the database).
// Nothing here talks to Gmail or writes a table: the module is the only caller of the write side (rule 5).
import {
  ApprovalsError,
  capabilityOf,
  editEmailProposal,
  listApprovals,
  pendingApprovalCount,
  rejectAction,
  type ActionRow,
  type ApprovalsPublicDeps,
  type ApproveResult,
  type CapabilityFacts,
  type Rpc,
  hasEmailPlaceholder,
  PLACEHOLDER_MESSAGE,
} from "@nichols/approvals/server";
import { AuthError, authErrorResponse, type Guards } from "@nichols/core/auth";
import { domainOf } from "@nichols/briefing/domain";
import { z } from "zod";
import { isOutcomeUnknown } from "./outcome";
import { draftReply, replyContext, ReplyError, saveReply, type ReplyDeps } from "./reply";
import { flagRecipients, type RecipientFlag } from "./reply-flags";

export const MAX_BODY_BYTES = 200_000;

export type ApprovalsApiDeps = {
  guards: () => Promise<Pick<Guards, "requireRole" | "requireStepUp">>;
  /** No write member (T-232 security review H1): approving goes through `approve`, which keeps the writer private. */
  approvals: ApprovalsPublicDeps;
  approve: (ctx: { laneId: ApprovalsCtx["laneId"]; userId: string; rpc: Rpc }, input: { actionId: string; hashSeen: string }) => Promise<ApproveResult>;
  /** Reply from the dashboard (T-234 part 3): the live reader, the AI provider and the rate limit. Absent: the reply actions answer `unavailable`. */
  reply?: ReplyDeps;
};
type ApprovalsCtx = Parameters<typeof listApprovals>[1];

type Client = Awaited<ReturnType<Guards["requireLane"]>>["client"];

/** The user's own (RLS) `core` rpc of a lane client. */
export function coreRpc(client: Client): Rpc {
  const core = (client as unknown as { schema(s: "core"): { rpc: unknown } }).schema("core");
  return (core.rpc as Rpc).bind(core);
}

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const address = z.email().max(320);
const uuid = z.uuid();
const messageId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const body = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("save"),
    id: uuid,
    to: z.array(address).min(1).max(100),
    cc: z.array(address).max(100),
    bcc: z.array(address).max(100),
    subject: z.string().min(1).max(998).refine((s) => !/[\r\n\u0000-\u001f]/.test(s), "no line breaks"),
    bodyText: z.string().min(1).max(100_000),
  }),
  z.strictObject({ action: z.literal("approve"), id: uuid, hashSeen: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({ action: z.literal("reject"), id: uuid, reason: z.string().trim().min(1).max(500) }),
  // Reply from the dashboard (T-234 part 3). The client names the message and sends only what the owner may edit: the thread,
  // subject and sending mailbox are always re-derived on the server from the message's metadata.
  z.strictObject({ action: z.literal("reply_context"), messageId }),
  z.strictObject({ action: z.literal("draft_reply"), messageId }),
  z.strictObject({
    action: z.literal("propose_reply"),
    messageId,
    to: z.array(address).min(1).max(100),
    cc: z.array(address).max(100),
    bodyText: z.string().min(1).max(100_000),
    /** The owner confirmed sending another reply to a conversation that already has a verified one. */
    confirmResend: z.boolean().optional(),
  }),
]);

const STATUS: Record<string, number> = {
  invalid: 400,
  forbidden: 403,
  step_up_required: 403,
  not_found: 404,
  hash_mismatch: 409,
  not_live: 409,
  not_enabled: 409,
  already_approved: 409,
  not_pending: 409,
  expired: 409,
  not_editable: 409,
  drafts_not_allowed: 409,
  too_many_pending: 429,
  sender_mismatch: 400,
  in_progress: 409,
  already_proposed: 409,
  reply_subject_fixed: 400,
  placeholder_in_body: 409,
  unavailable: 503,
  // reply actions (lib/reply.ts)
  not_replyable: 409,
  ai_not_allowed: 409,
  ai_not_configured: 503,
  ai_failed: 502,
  rate_limited: 429,
  body_unavailable: 502,
  check_sent_first: 409,
  already_replied: 409,
  draft_exists: 409,
  reply_already_pending: 409,
};

export async function handleApprovals(request: Request, laneId: string, deps: ApprovalsApiDeps): Promise<Response> {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return json(403, { error: "forbidden" });
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: "invalid_request" });
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_BODY_BYTES) return json(400, { error: "invalid_request" });
  const raw = await request.text().catch(() => "");
  if (raw.length === 0 || new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json(400, { error: "invalid_request" });
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_request" });
  }
  const parsed = body.safeParse(parsedBody);
  if (!parsed.success) return json(400, { error: "invalid_request" });
  const req = parsed.data;

  try {
    const g = await deps.guards();
    const { session, client } = await g.requireRole(laneId, ["owner"]);
    const ctx = { laneId, userId: session.userId, rpc: coreRpc(client) };
    switch (req.action) {
      case "save": {
        const r = await editEmailProposal(deps.approvals, ctx, req.id, { to: req.to, cc: req.cc, bcc: req.bcc, subject: req.subject, bodyText: req.bodyText });
        return json(200, { ok: true, id: r.id, hash: r.hash, unchanged: r.unchanged });
      }
      case "reject":
        await rejectAction(deps.approvals, ctx, req.id, req.reason);
        return json(200, { ok: true });
      case "approve": {
        // The step-up age is the lane's setting; the mailbox facts are read for the action's own connection.
        const got = await ctx.rpc("act_get", { p_lane: laneId, p_id: req.id });
        const row = !got.error && Array.isArray(got.data) && got.data.length > 0 ? (got.data[0] as { connection_id?: unknown }) : null;
        if (!row || typeof row.connection_id !== "string") return json(404, { error: "not_found" });
        const facts = await deps.approvals.readFacts(laneId, row.connection_id);
        await g.requireStepUp(facts.stepUpMaxAgeS);
        const result = await deps.approve(ctx, { actionId: req.id, hashSeen: req.hashSeen });
        // `outcome` is the owner's reading of the result: "sent", "failed" (nothing went out) or "unknown" (it MAY have: check Sent; never offer a blind retry).
        const outcome = result.status === "verified" ? "sent" : result.status === "failed" ? (isOutcomeUnknown(result.failureCode) ? "unknown" : "failed") : "unknown";
        return json(200, { ok: true, ...result, outcome });
      }
      case "reply_context":
      case "draft_reply":
      case "propose_reply": {
        if (!deps.reply) return json(503, { error: "unavailable" });
        if (req.action === "reply_context") return json(200, { ok: true, context: await replyContext(ctx, client, deps.approvals, deps.reply, req.messageId) });
        if (req.action === "draft_reply") return json(200, { ok: true, draft: await draftReply(ctx, client, deps.approvals, deps.reply, req.messageId) });
        const saved = await saveReply(ctx, client, deps.approvals, deps.reply, { messageId: req.messageId, to: req.to, cc: req.cc, bodyText: req.bodyText, confirmResend: req.confirmResend === true });
        return json(200, { ok: true, id: saved.id, hash: saved.hash, unchanged: saved.unchanged });
      }
    }
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e) as Response;
    if (e instanceof ReplyError && e.retryAfterS !== null) return json(STATUS[e.code] ?? 500, { error: e.code, message: e.message, retryAfterS: e.retryAfterS });
    if (e instanceof ApprovalsError || e instanceof ReplyError) return json(STATUS[e.code] ?? 500, { error: e.code, message: e.message });
    console.error("[approvals] unavailable:", e instanceof Error ? e.name : typeof e);
    return json(503, { error: "unavailable" });
  }
}

// ---------------------------------------------------------------- page view models

export type CardCapability = { enabled: boolean; message: string | null; settingsHref: string | null };
export type PendingCard = {
  id: string;
  actionType: "email.send" | "email.save_draft";
  mailbox: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  rationale: string | null;
  derivedFromRetrieved: boolean;
  hash: string;
  shortHash: string;
  expiresAt: string;
  replyThread: boolean;
  /** Per-recipient warnings (spec §8; T-232 security review M1): a domain outside the lane's mailboxes, or a hidden copy. */
  recipientFlags: RecipientFlag[];
  capability: CardCapability;
  /** The subject or body still holds a placeholder such as "[amount]" (T-237): Approve is off until it is edited out. */
  placeholder: string | null;
};
export type { RecipientFlag };

/** Flags every recipient whose domain is not one of the lane's own mailbox domains, and every bcc. */
export function recipientFlags(payload: Record<string, unknown>, internalDomains: readonly string[]): RecipientFlag[] {
  return flagRecipients({ to: strs(payload.to), cc: strs(payload.cc), bcc: strs(payload.bcc) }, internalDomains);
}
/** Failure codes after which the email MAY have gone out: the owner must check the Sent folder before asking again (lib/outcome.ts). */
export { isOutcomeUnknown };
export type HistoryItem = {
  id: string;
  actionType: "email.send" | "email.save_draft";
  status: ActionRow["status"];
  to: string[];
  subject: string;
  failureCode: string | null;
  /** True when the email may already have been sent or saved: check the mailbox before asking again. */
  outcomeUnknown: boolean;
  at: string;
  contentPurged: boolean;
};
export type ApprovalsView = { isOwner: boolean; pending: PendingCard[]; history: HistoryItem[]; unavailable?: true };

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function toCard(row: ActionRow, facts: CapabilityFacts, laneId: string, internalDomains: readonly string[] = []): PendingCard {
  const cap = capabilityOf(laneId, facts, row.actionType);
  return {
    id: row.id,
    actionType: row.actionType,
    mailbox: typeof row.payload.fromMailbox === "string" ? row.payload.fromMailbox : (facts.mailbox ?? ""),
    to: strs(row.payload.to),
    cc: strs(row.payload.cc),
    bcc: strs(row.payload.bcc),
    subject: typeof row.payload.subject === "string" ? row.payload.subject : "",
    bodyText: typeof row.payload.bodyText === "string" ? row.payload.bodyText : "",
    rationale: row.rationale,
    derivedFromRetrieved: row.derivedFromRetrieved,
    hash: row.payloadSha256,
    shortHash: row.payloadSha256.slice(0, 8),
    expiresAt: row.expiresAt,
    replyThread: typeof row.target.thread_id === "string",
    recipientFlags: recipientFlags(row.payload, [...internalDomains, ...(facts.mailbox ? [domainOf(facts.mailbox)] : [])]),
    capability: { enabled: cap.enabled, message: cap.message, settingsHref: cap.settingsHref },
    placeholder: hasEmailPlaceholder(row.payload, typeof row.target.thread_id === "string") ? PLACEHOLDER_MESSAGE : null,
  };
}

export function toHistory(row: ActionRow): HistoryItem {
  return {
    id: row.id,
    actionType: row.actionType,
    status: row.status,
    to: strs(row.payload.to),
    subject: typeof row.payload.subject === "string" ? row.payload.subject : "",
    failureCode: row.failureCode,
    outcomeUnknown: row.status === "failed" && isOutcomeUnknown(row.failureCode),
    at: row.verifiedAt ?? row.updatedAt,
    contentPurged: row.payloadPurgedAt !== null,
  };
}

export async function loadApprovals(
  g: Pick<Guards, "requireLane" | "requireRole">,
  approvals: ApprovalsPublicDeps,
  laneId: string,
): Promise<ApprovalsView> {
  const lane = await g.requireLane(laneId);
  let isOwner = true;
  try {
    await g.requireRole(laneId, ["owner"]);
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    isOwner = false;
  }
  try {
    const rows = await listApprovals(approvals, { laneId, userId: lane.session.userId, rpc: coreRpc(lane.client) }, 100);
    const facts = new Map<string, CapabilityFacts>();
    const pending: PendingCard[] = [];
    const domains = (await approvals.laneMailboxes(laneId as Parameters<typeof approvals.laneMailboxes>[0]).catch(() => [] as string[])).map((m) => domainOf(m));
    for (const row of rows.filter((r) => r.status === "proposed" && new Date(r.expiresAt).getTime() > Date.now())) {
      let f = facts.get(row.connectionId);
      if (!f) {
        f = await approvals.readFacts(laneId, row.connectionId);
        facts.set(row.connectionId, f);
      }
      pending.push(toCard(row, f, laneId, domains));
    }
    const history = rows
      .filter((r) => r.status !== "proposed")
      .slice(0, 20)
      .map(toHistory);
    return { isOwner, pending, history };
  } catch {
    return { isOwner, pending: [], history: [], unavailable: true };
  }
}

/** Waiting count for Home; 0 when the user may see none or approvals are not available (never throws). */
export async function waitingCount(g: Pick<Guards, "requireLane">, laneId: string): Promise<number> {
  try {
    const lane = await g.requireLane(laneId);
    return await pendingApprovalCount({ laneId, userId: lane.session.userId, rpc: coreRpc(lane.client) });
  } catch {
    return 0;
  }
}
