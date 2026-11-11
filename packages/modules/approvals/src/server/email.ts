// The Approval Center for email (T-232; docs/specs/approvals.md, email-only subset): propose, edit, approve + execute,
// reject, list. The only code that calls the connectors' write side (rule 5).
//
//   propose  built from the connector's prepareWrite (the sender is always the connection's mailbox), hashed in canonical
//            JSON here, stored through act.propose (service role), audited with ids, type and hash (never the body).
//   edit     a new proposal that supersedes the old one (the old one is invalidated and loses its body).
//   approve  the route has done requireRole(owner) and requireStepUp(max age); the database checks aal2, the TOTP age,
//            the owner role, the hash the approver saw and every gate again (act.approve). Then: audit -> claim (single) ->
//            execute through the Gmail writer -> read back -> mark verified or failed -> audit. At most one external write.
//   reject   act.reject (reason required); the body is purged in the same statement.
//
// Retrieved content never approves or executes anything: proposals come from a user action or a job the owner configured,
// `derivedFromRetrieved` is stored and shown, and nothing here reads or follows instructions inside an email.
import type { LaneId } from "@nichols/core";
import type { AuditEntry } from "@nichols/core/audit";
import { isConnectorError } from "@nichols/connectors";
import { OUTCOME_UNKNOWN_MESSAGE, VERIFICATION_MISMATCH_MESSAGE, type GoogleEmailApprovedAction } from "@nichols/connectors/write";
import { capabilityOf } from "./capability";
import { ApprovalsError, toApprovalsError } from "./errors";
import { firstRow, hashOfRow, rowsOf } from "./rows";
import type { ActionRow, ApprovalsDeps, ApprovalsPublicDeps, EmailActionType, ProposerKind, Rpc, UserCtx } from "./types";
import { EMAIL_ACTION_TYPES } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANE = /^[A-Z]{1,8}$/;

/** What a caller composes. `fromMailbox` may be omitted (it is the connection's mailbox); a different one is refused. */
export type EmailComposeInput = {
  to: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject: string;
  bodyText: string;
  /** Reply into a thread: Gmail thread id and the id of the message replied to. */
  inReplyTo?: { threadId: string; messageId: string };
  fromMailbox?: string;
};

/**
 * Input of `proposeEmailAction`. This is the interface the briefing job (T-231d) uses to create `email.send` proposals:
 * `proposerKind: "job"`, `derivedFromRetrieved: true` (the recipient and thread came from email), `proposerUserId` = the owner
 * the briefing is for.
 */
export type ProposeEmailInput = {
  actionType: EmailActionType;
  connectionId: string;
  compose: EmailComposeInput;
  /** The assistant's note, shown as "not verified". Plain text, at most 2000 characters. */
  rationale?: string;
  /** Display-only citations (ids, never bodies). At most 20. */
  sourceRefs?: readonly unknown[];
  proposerKind: ProposerKind;
  /** Required for `user`; the person the proposal is for otherwise (they see it as their own). */
  proposerUserId?: string;
  /** True when recipients, thread or text were taken from retrieved content (shown as a banner next to the recipients). */
  derivedFromRetrieved: boolean;
};

export type ProposeResult = { id: string; hash: string };
export type ApproveResult =
  | { status: "verified"; actionId: string }
  | { status: "failed"; actionId: string; failureCode: string }
  | { status: "already_in_progress"; actionId: string };

function checkLane(laneId: LaneId): void {
  if (typeof laneId !== "string" || !LANE.test(laneId)) throw new ApprovalsError("invalid");
}
function checkId(id: string): void {
  if (typeof id !== "string" || !UUID.test(id)) throw new ApprovalsError("invalid");
}
const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Writes an audit entry; ids, type, hash and codes only. A failure to audit stops the caller (the action does not proceed). */
async function audit(deps: Pick<ApprovalsPublicDeps, "audit">, laneId: LaneId, actor: AuditEntry["actor"], action: string, actionId: string, metadata: Record<string, unknown>): Promise<void> {
  await deps.audit.log({ laneId, actor, action, target: `action:${actionId}`, metadata });
}

/** Builds the exact stored proposal for an email: sender fixed to the connection's mailbox, canonical hash. */
async function buildProposal(deps: ApprovalsPublicDeps, laneId: LaneId, actionType: EmailActionType, connectionId: string, compose: EmailComposeInput) {
  if (!EMAIL_ACTION_TYPES.includes(actionType)) throw new ApprovalsError("invalid");
  checkId(connectionId);
  const facts = await deps.readFacts(laneId, connectionId);
  if (facts.mailbox === null) throw new ApprovalsError("invalid");
  const mailbox = facts.mailbox.toLowerCase();
  if (compose.fromMailbox !== undefined && compose.fromMailbox.toLowerCase() !== mailbox) throw new ApprovalsError("sender_mismatch");
  if (!(await deps.laneMailboxes(laneId)).includes(mailbox)) throw new ApprovalsError("sender_mismatch");
  let prepared: Awaited<ReturnType<ApprovalsDeps["prepareEmailWrite"]>>;
  try {
    prepared = await deps.prepareEmailWrite(laneId, connectionId, {
      action_type: actionType,
      compose: {
        fromMailbox: mailbox,
        to: [...compose.to],
        cc: [...(compose.cc ?? [])],
        bcc: [...(compose.bcc ?? [])],
        subject: compose.subject,
        bodyText: compose.bodyText,
        ...(compose.inReplyTo ? { inReplyTo: { ...compose.inReplyTo } } : {}),
      },
    });
  } catch (e) {
    if (isConnectorError(e)) throw new ApprovalsError(e.info.kind === "forbidden" ? "sender_mismatch" : e.info.kind === "invalid_input" ? "invalid" : "unavailable");
    throw new ApprovalsError("unavailable");
  }
  const { proposed, connection } = prepared;
  const target = cloneJson(proposed.target);
  const payload = cloneJson(proposed.payload);
  const hash = hashOfRow({ laneId, actionType, connectionId: connection.id, target, payload, payloadSchemaVersion: proposed.payload_schema_version });
  return { connectionId: connection.id, target, payload, version: proposed.payload_schema_version, hash };
}

/** Creates a proposal. Never executes; nothing is sent until the owner approves. */
export async function proposeEmailAction(deps: ApprovalsPublicDeps, laneId: LaneId, input: ProposeEmailInput): Promise<ProposeResult> {
  checkLane(laneId);
  if (input.proposerKind === "user" && !input.proposerUserId) throw new ApprovalsError("invalid");
  if (input.proposerUserId !== undefined && !UUID.test(input.proposerUserId)) throw new ApprovalsError("invalid");
  if (typeof input.derivedFromRetrieved !== "boolean") throw new ApprovalsError("invalid");
  if (input.rationale !== undefined && (typeof input.rationale !== "string" || input.rationale.length > 2000)) throw new ApprovalsError("invalid");
  if (input.sourceRefs !== undefined && input.sourceRefs.length > 20) throw new ApprovalsError("invalid");
  const p = await buildProposal(deps, laneId, input.actionType, input.connectionId, input.compose);
  const rpc = await deps.jobRpc(laneId);
  const { data, error } = await rpc("act_propose", {
    p_lane: laneId,
    p_type: input.actionType,
    p_connection: p.connectionId,
    p_target: p.target,
    p_payload: p.payload,
    p_version: p.version,
    p_hash: p.hash,
    p_rationale: input.rationale ?? null,
    p_source_refs: cloneJson([...(input.sourceRefs ?? [])]),
    p_proposer_kind: input.proposerKind,
    p_proposer_user: input.proposerUserId ?? null,
    p_derived: input.derivedFromRetrieved,
  });
  if (error) throw toApprovalsError(error);
  if (typeof data !== "string" || !UUID.test(data)) throw new ApprovalsError("unavailable");
  await audit(deps, laneId, input.proposerUserId ? { kind: "user", userId: input.proposerUserId } : { kind: "service" }, "action.proposed", data, {
    action_type: input.actionType,
    connection_id: p.connectionId,
    hash: p.hash,
    proposer_kind: input.proposerKind,
    derived_from_retrieved: input.derivedFromRetrieved,
  });
  return { id: data, hash: p.hash };
}

async function getRow(rpc: Rpc, laneId: LaneId, actionId: string): Promise<ActionRow> {
  const { data, error } = await rpc("act_get", { p_lane: laneId, p_id: actionId });
  if (error) throw toApprovalsError(error);
  if (!Array.isArray(data) || data.length === 0) throw new ApprovalsError("not_found");
  return firstRow(data);
}

async function requireOwner(ctx: UserCtx): Promise<void> {
  const { data, error } = await ctx.rpc("has_lane_role", { p_uid: ctx.userId, p_lane: ctx.laneId, p_roles: ["owner"] });
  if (error) throw toApprovalsError(error);
  if (data !== true) throw new ApprovalsError("forbidden");
}

export type EmailChanges = Partial<Pick<EmailComposeInput, "to" | "cc" | "bcc" | "subject" | "bodyText">>;

/**
 * An edit is a new proposal that supersedes the old one (which becomes invalidated and loses its body). The recipients and
 * text are the owner's now: the "derived from retrieved content" flag stays only while the recipients are unchanged.
 * Returns the old id unchanged when nothing differs.
 */
export async function editEmailProposal(deps: ApprovalsPublicDeps, ctx: UserCtx, actionId: string, changes: EmailChanges): Promise<ProposeResult & { unchanged: boolean }> {
  checkLane(ctx.laneId);
  checkId(actionId);
  await requireOwner(ctx);
  const old = await getRow(ctx.rpc, ctx.laneId, actionId);
  if (old.status !== "proposed") throw new ApprovalsError("not_editable");
  const body = old.payload.bodyText;
  if (typeof body !== "string" || old.payloadPurgedAt !== null) throw new ApprovalsError("not_editable");
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // A reply keeps its subject: Gmail files a reply with a different subject in a new thread, the read-back then fails
  // although the email went out, and a retry would send it twice (T-232 code review H1).
  if (old.payload.inReplyTo && changes.subject !== undefined && changes.subject.trim() !== String(old.payload.subject ?? "").trim()) {
    throw new ApprovalsError("reply_subject_fixed");
  }
  const compose: EmailComposeInput = {
    to: changes.to ?? list(old.payload.to),
    cc: changes.cc ?? list(old.payload.cc),
    bcc: changes.bcc ?? list(old.payload.bcc),
    subject: changes.subject ?? String(old.payload.subject ?? ""),
    bodyText: changes.bodyText ?? body,
    ...(old.payload.inReplyTo ? { inReplyTo: old.payload.inReplyTo as { threadId: string; messageId: string } } : {}),
  };
  const p = await buildProposal(deps, ctx.laneId, old.actionType, old.connectionId, compose);
  if (p.hash === old.payloadSha256) return { id: old.id, hash: old.payloadSha256, unchanged: true };
  const sameRecipients = (["to", "cc", "bcc"] as const).every((k) => JSON.stringify((p.payload[k] as unknown[]) ?? []) === JSON.stringify(old.payload[k] ?? []));
  const job = await deps.jobRpc(ctx.laneId);
  const { data, error } = await job("act_supersede", {
    p_lane: ctx.laneId,
    p_old: old.id,
    p_target: p.target,
    p_payload: p.payload,
    p_version: p.version,
    p_hash: p.hash,
    p_rationale: null,
    p_source_refs: [],
    p_proposer_user: ctx.userId,
    p_derived: old.derivedFromRetrieved && sameRecipients,
  });
  if (error) throw toApprovalsError(error);
  if (typeof data !== "string" || !UUID.test(data)) throw new ApprovalsError("unavailable");
  await audit(deps, ctx.laneId, { kind: "user", userId: ctx.userId }, "action.edited", data, { old_action_id: old.id, hash: p.hash, action_type: old.actionType });
  return { id: data, hash: p.hash, unchanged: false };
}

export async function rejectAction(deps: ApprovalsPublicDeps, ctx: UserCtx, actionId: string, reason: string): Promise<void> {
  checkLane(ctx.laneId);
  checkId(actionId);
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < 1 || text.length > 500) throw new ApprovalsError("invalid");
  const { error } = await ctx.rpc("act_reject", { p_lane: ctx.laneId, p_id: actionId, p_reason: text });
  if (error) throw toApprovalsError(error);
  await audit(deps, ctx.laneId, { kind: "user", userId: ctx.userId }, "action.rejected", actionId, {});
}

type FailureOutcome = "mismatch" | "error" | "outcome_unknown";
function failureOf(e: unknown, stage: "before" | "send" | "verify"): { code: string; outcome: FailureOutcome } {
  if (e instanceof TamperError) return { code: "payload_changed", outcome: "error" };
  if (isConnectorError(e)) {
    if (e.info.message === OUTCOME_UNKNOWN_MESSAGE) return { code: "outcome_unknown", outcome: "outcome_unknown" };
    if (e.info.message === VERIFICATION_MISMATCH_MESSAGE) return { code: "verification_mismatch", outcome: "mismatch" };
    // The email may already be in the mailbox: never report a plain failure for a read-back that could not run.
    if (stage === "verify") return { code: "verification_unavailable", outcome: "outcome_unknown" };
    if (e.info.kind === "reconnect_required" || e.info.kind === "connection_unavailable") return { code: "connection_unhealthy", outcome: "error" };
    if (["forbidden", "invalid_input", "lane_mismatch", "unsupported_op"].includes(e.info.kind)) return { code: "execution_refused", outcome: "error" };
    return { code: "execution_error", outcome: "error" };
  }
  return stage === "verify" ? { code: "verification_unavailable", outcome: "outcome_unknown" } : { code: "execution_error", outcome: "error" };
}
class TamperError extends Error {
  override readonly name = "TamperError";
}

/**
 * Approves the exact payload the owner saw and carries it out once. The caller (the route) has done requireRole(owner) and
 * requireStepUp(step_up_max_age_s); the database checks both again. Returns what happened; throws ApprovalsError for a
 * refusal before anything was sent (hash mismatch, not enabled, not live, expired, already approved, ...).
 */
export async function approveAndExecute(deps: ApprovalsDeps, ctx: UserCtx, input: { actionId: string; hashSeen: string }): Promise<ApproveResult> {
  checkLane(ctx.laneId);
  checkId(input.actionId);
  if (typeof input.hashSeen !== "string" || !/^[0-9a-f]{64}$/.test(input.hashSeen)) throw new ApprovalsError("invalid");
  const actor = { kind: "user" as const, userId: ctx.userId };
  const blocked = async (reason: string): Promise<never> => {
    await audit(deps, ctx.laneId, actor, "action.gate_blocked", input.actionId, { reason }).catch(() => undefined);
    throw new ApprovalsError(reason as ApprovalsError["code"]);
  };

  const row = await getRow(ctx.rpc, ctx.laneId, input.actionId);
  if (row.status === "approved") {
    // Resume (T-232 code review H2): approved by this owner, for this exact hash, but never carried out (an audit
    // outage or a killed request after act_approve). The single claim keeps it to one execution; the gates run again.
    if (row.approvedBy !== ctx.userId || row.approvedHash !== row.payloadSha256 || input.hashSeen !== row.payloadSha256 || hashOfRow(row) !== row.payloadSha256) {
      return blocked("already_approved");
    }
    const capNow = capabilityOf(ctx.laneId, await deps.readFacts(ctx.laneId, row.connectionId), row.actionType);
    if (!capNow.enabled) return blocked(capNow.reason);
    await audit(deps, ctx.laneId, actor, "action.resumed", row.id, { action_type: row.actionType, hash: row.payloadSha256 });
    return executeApproved(deps, ctx.laneId, row.id);
  }
  if (row.status !== "proposed") return blocked("not_pending");
  // The stored content must still hash to the stored hash, and the hash the approver saw must be that hash.
  if (hashOfRow(row) !== row.payloadSha256 || input.hashSeen !== row.payloadSha256) return blocked("hash_mismatch");
  const facts = await deps.readFacts(ctx.laneId, row.connectionId);
  const cap = capabilityOf(ctx.laneId, facts, row.actionType);
  if (!cap.enabled) return blocked(cap.reason);

  const approved = await ctx.rpc("act_approve", { p_lane: ctx.laneId, p_id: row.id, p_hash_seen: input.hashSeen });
  if (approved.error) {
    const err = toApprovalsError(approved.error);
    await audit(deps, ctx.laneId, actor, "action.gate_blocked", row.id, { reason: err.code }).catch(() => undefined);
    throw err;
  }
  await audit(deps, ctx.laneId, actor, "action.approved", row.id, { action_type: row.actionType, hash: row.payloadSha256 });
  return executeApproved(deps, ctx.laneId, row.id);
}

/**
 * approved -> executing (the single claim) -> send or save -> read back -> verified or failed. A second call (a duplicate
 * request, a parallel worker) finds the claim taken and returns `already_in_progress` without touching Gmail.
 */
export async function executeApproved(deps: ApprovalsDeps, laneId: LaneId, actionId: string): Promise<ApproveResult> {
  const job = await deps.jobRpc(laneId);
  // "An unaudited action never runs": the start is written before the claim and before any external call.
  await audit(deps, laneId, { kind: "service" }, "action.execute_started", actionId, {});
  const claimed = await job("act_claim_execution", { p_lane: laneId, p_id: actionId });
  if (claimed.error) {
    const err = toApprovalsError(claimed.error);
    if (err.code === "in_progress" || err.code === "not_pending") return { status: "already_in_progress", actionId };
    await audit(deps, laneId, { kind: "service" }, "action.gate_blocked", actionId, { reason: err.code }).catch(() => undefined);
    throw err;
  }
  const row = firstRow(claimed.data);
  // The approver is the one the database recorded, never a caller's word (T-232 reviews M4 / L6).
  const approvedBy = row.approvedBy;

  let stage: "before" | "send" | "verify" = "before";
  let verified = false;
  let externalId: string | null = null;
  let outcome: "accepted" | "already_applied" = "accepted";
  try {
    // Immediately before the external call: the stored content must still be what was approved.
    if (hashOfRow(row) !== row.payloadSha256 || row.approvedHash !== row.payloadSha256) throw new TamperError();
    if (typeof approvedBy !== "string" || !UUID.test(approvedBy)) throw new TamperError();
    if (typeof row.payload.bodyText !== "string") throw new TamperError();
    const action: GoogleEmailApprovedAction = {
      id: row.id,
      lane_id: laneId,
      connection_id: row.connectionId,
      action_type: row.actionType,
      target: row.target as GoogleEmailApprovedAction["target"],
      payload: row.payload as GoogleEmailApprovedAction["payload"],
      payload_schema_version: row.payloadSchemaVersion,
      payload_sha256: row.payloadSha256,
      approved_by: approvedBy,
    };
    const conn = await deps.loadWriteConnection(laneId, row.connectionId);
    stage = "send";
    const res = await deps.writer.executeWrite(laneId, conn, action);
    if (res.external_id === null) throw new ApprovalsError("unavailable");
    externalId = res.external_id;
    outcome = res.outcome;
    stage = "verify";
    const sent = await job("act_claim_sent", { p_lane: laneId, p_id: actionId, p_external_id: externalId });
    if (sent.error) throw toApprovalsError(sent.error);
    await deps.writer.verifyWrite(laneId, conn, action, externalId);
    verified = true;
    const done = await job("act_mark_verified", { p_lane: laneId, p_id: actionId, p_external_id: externalId, p_outcome: outcome });
    if (done.error) throw toApprovalsError(done.error);
  } catch (e) {
    if (verified) {
      // Sent and read back; only recording it failed (T-232 code review M1). Never turn a sent email into "failed": the
      // row stays executing with its claim at "sent" (the reconcile sweep, T-192, finishes it), and the owner is told it went out.
      console.error("[approvals] verified send could not be recorded", { laneId, actionId });
      await audit(deps, laneId, { kind: "service" }, "action.record_failed", actionId, { external_id: externalId }).catch(() => undefined);
      return { status: "verified", actionId };
    }
    const f = failureOf(e, stage);
    let marked: Awaited<ReturnType<typeof job>>;
    try {
      marked = await job("act_mark_failed", { p_lane: laneId, p_id: actionId, p_code: f.code, p_outcome: f.outcome });
    } catch {
      marked = { data: null, error: { message: "mark_failed unavailable" } };
    }
    await audit(deps, laneId, { kind: "service" }, "action.failed", actionId, { failure_code: f.code, outcome: f.outcome }).catch(() => undefined);
    if (marked.error) throw new ApprovalsError("unavailable");
    return { status: "failed", actionId, failureCode: f.code };
  }
  await audit(deps, laneId, { kind: "service" }, "action.verified", actionId, { outcome, external_id: externalId }).catch(() => undefined);
  return { status: "verified", actionId };
}

export type ApprovalsList = { rows: ActionRow[] };

/** The lane's actions as the signed-in user may see them (RLS), newest pending first. Stale proposals are expired first. */
export async function listApprovals(deps: ApprovalsPublicDeps, ctx: UserCtx, limit = 50): Promise<ActionRow[]> {
  checkLane(ctx.laneId);
  try {
    const job = await deps.jobRpc(ctx.laneId);
    await job("act_expire_stale", { p_lane: ctx.laneId });
  } catch {
    // Listing still works; the database refuses to approve an expired proposal anyway.
  }
  const { data, error } = await ctx.rpc("act_list", { p_lane: ctx.laneId, p_limit: limit });
  if (error) throw toApprovalsError(error);
  return rowsOf(data);
}

/** The number of proposals waiting for the signed-in user in a lane (Home). 0 when they may not see any. */
export async function pendingApprovalCount(ctx: UserCtx): Promise<number> {
  checkLane(ctx.laneId);
  const { data, error } = await ctx.rpc("act_pending_count", { p_lane: ctx.laneId });
  if (error) throw toApprovalsError(error);
  return typeof data === "number" && Number.isInteger(data) && data >= 0 ? data : 0;
}
