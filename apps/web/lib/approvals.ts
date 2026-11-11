// Approvals page data and API (T-232). Logic lives here so it is testable without Next: the page loader builds plain view
// models (pending cards with their capability, recent history), and `handleApprovals` is the POST handler:
//   same-origin JSON, bounded body -> body schema -> AAL2 session + OWNER role in the lane -> (approve only) a TOTP step-up
//   within the lane's step_up_max_age_s -> the approvals module (which re-checks everything in the database).
// Nothing here talks to Gmail or writes a table: the module is the only caller of the write side (rule 5).
import {
  ApprovalsError,
  approveAndExecute,
  capabilityOf,
  editEmailProposal,
  listApprovals,
  pendingApprovalCount,
  rejectAction,
  type ActionRow,
  type ApprovalsDeps,
  type CapabilityFacts,
  type Rpc,
} from "@nichols/approvals/server";
import { AuthError, authErrorResponse, type Guards } from "@nichols/core/auth";
import { z } from "zod";

export const MAX_BODY_BYTES = 200_000;

export type ApprovalsApiDeps = {
  guards: () => Promise<Pick<Guards, "requireRole" | "requireStepUp">>;
  approvals: ApprovalsDeps;
};

type Client = Awaited<ReturnType<Guards["requireLane"]>>["client"];

/** The user's own (RLS) `core` rpc of a lane client. */
export function coreRpc(client: Client): Rpc {
  const core = (client as unknown as { schema(s: "core"): { rpc: unknown } }).schema("core");
  return (core.rpc as Rpc).bind(core);
}

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const address = z.email().max(320);
const uuid = z.uuid();
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
  unavailable: 503,
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
        const row = (await listApprovals(deps.approvals, ctx, 100)).find((r) => r.id === req.id);
        if (!row) return json(404, { error: "not_found" });
        const facts = await deps.approvals.readFacts(laneId, row.connectionId);
        await g.requireStepUp(facts.stepUpMaxAgeS);
        const result = await approveAndExecute(deps.approvals, ctx, { actionId: req.id, hashSeen: req.hashSeen });
        return json(200, { ok: true, ...result });
      }
    }
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e) as Response;
    if (e instanceof ApprovalsError) return json(STATUS[e.code] ?? 500, { error: e.code, message: e.message });
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
  capability: CardCapability;
};
export type HistoryItem = {
  id: string;
  actionType: "email.send" | "email.save_draft";
  status: ActionRow["status"];
  to: string[];
  subject: string;
  failureCode: string | null;
  at: string;
  contentPurged: boolean;
};
export type ApprovalsView = { isOwner: boolean; pending: PendingCard[]; history: HistoryItem[]; unavailable?: true };

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function toCard(row: ActionRow, facts: CapabilityFacts, laneId: string): PendingCard {
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
    capability: { enabled: cap.enabled, message: cap.message, settingsHref: cap.settingsHref },
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
    at: row.verifiedAt ?? row.updatedAt,
    contentPurged: row.payloadPurgedAt !== null,
  };
}

export async function loadApprovals(
  g: Pick<Guards, "requireLane" | "requireRole">,
  approvals: ApprovalsDeps,
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
    for (const row of rows.filter((r) => r.status === "proposed" && new Date(r.expiresAt).getTime() > Date.now())) {
      let f = facts.get(row.connectionId);
      if (!f) {
        f = await approvals.readFacts(laneId, row.connectionId);
        facts.set(row.connectionId, f);
      }
      pending.push(toCard(row, f, laneId));
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
