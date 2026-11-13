// The Approval Center for the QuickBooks disconnect (T-195, D-24): `qbo.disconnect`. Same life cycle and the same database
// functions as email (docs/specs/approvals.md), with these differences:
//   * who: owner or admin_technical of the lane may propose, approve and reject it (WRITE_ROLES; the database checks again).
//   * what: target = {realm_id} of the lane's QuickBooks connection, payload = {} and nothing else (no token, no company name).
//   * the gate is the same as email: lane policy class `qbo_disconnect` + `approvals_live` (T-170), at approve and at claim.
//   * execute: the connector's approvals-only writer (`quickbooksWriter`, action "qbo.disconnect") revokes the grant at Intuit
//     once and, through the Vault, deletes the tokens and marks the connection `disconnected`; then a read-back
//     (`quickbooksDisconnectVerifier`) confirms the connection is `disconnected` with no token. No T-113 (not built): like email,
//     the execution runs inline right after the approval; a stuck one is finished by action.reconcile_stuck (reconcile-qbo.ts).
//   * the executor reads `payload_sha256` and `approved_by` from the claimed (locked) act.proposed_actions row, never from the caller.
//
// Failure semantics. Revoking at Intuit is repeatable and the writer keeps the Vault tokens unless Intuit confirmed (or said
// "already revoked"), so a failure before the read-back is a plain failed action: the connection is still connected and a new
// proposal can be made. A failed read-back is `outcome_unknown` (the revoke may have gone through).
//
// Retrieved content never approves or executes anything: a disconnect is proposed only by a person's own request
// (`proposerKind: "user"`), never by a job or the assistant.
import { isConnectorError } from "@nichols/connectors";
import type { LaneBoundConnection } from "@nichols/connectors";
import { QBO_VERIFICATION_MISMATCH_MESSAGE, type QboApprovedAction } from "@nichols/connectors/write";
import type { LaneId } from "@nichols/core";
import { capabilityOf } from "./capability";
import { audit, checkId, checkLane, getRow, settledState, type ApproveResult, type ProposeResult } from "./email";
import { ApprovalsError, toApprovalsError } from "./errors";
import { firstRow, hashOfRow } from "./rows";
import { QBO_DISCONNECT, WRITE_ROLES, type ActionRow, type ApprovalsPublicDeps, type Rpc, type UserCtx } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const QBO_PAYLOAD_VERSION = 1;

/** What the executor needs besides the public deps: the write path, kept private to `wire.ts` like the email writer. */
export type QboExecDeps = ApprovalsPublicDeps & {
  loadWriteConnection(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<"quickbooks">>;
  writer: { executeWrite(laneId: LaneId, conn: LaneBoundConnection<"quickbooks">, action: QboApprovedAction): Promise<{ outcome: "accepted" | "already_applied"; external_id: string | null }> };
  verifier: { verify(laneId: LaneId, conn: LaneBoundConnection<"quickbooks">, action: Pick<QboApprovedAction, "lane_id" | "connection_id" | "target">): Promise<void> };
};

/** The provider id recorded for a disconnect: the connection (there is no object at Intuit to point to). */
export const qboExternalId = (connectionId: string): string => `connection:${connectionId}`;

async function requireRole(ctx: UserCtx): Promise<void> {
  const { data, error } = await ctx.rpc("has_lane_role", { p_uid: ctx.userId, p_lane: ctx.laneId, p_roles: [...WRITE_ROLES[QBO_DISCONNECT]] });
  if (error) throw toApprovalsError(error);
  if (data !== true) throw new ApprovalsError("forbidden");
}

/**
 * Proposes disconnecting the lane's QuickBooks connection. A person's own request (owner or admin_technical, checked here and in
 * the database). Never executes: nothing changes at Intuit until someone approves the exact payload with a fresh step-up.
 * `not_found` when the connection is not a QuickBooks connection of this lane (another lane's, another provider's, or already disconnected).
 */
export async function proposeQboDisconnect(deps: ApprovalsPublicDeps, ctx: UserCtx, input: { connectionId: string }): Promise<ProposeResult> {
  checkLane(ctx.laneId);
  checkId(input.connectionId);
  if (typeof ctx.userId !== "string" || !UUID.test(ctx.userId)) throw new ApprovalsError("invalid");
  await requireRole(ctx);
  const facts = await deps.readFacts(ctx.laneId, input.connectionId);
  if (!facts.qbo) throw new ApprovalsError("not_found");
  const target = cloneJson({ realm_id: facts.qbo.realmId });
  const payload = cloneJson({});
  const hash = hashOfRow({ laneId: ctx.laneId, actionType: QBO_DISCONNECT, connectionId: input.connectionId, target, payload, payloadSchemaVersion: QBO_PAYLOAD_VERSION });
  const rpc = await deps.jobRpc(ctx.laneId);
  const { data, error } = await rpc("act_propose", {
    p_lane: ctx.laneId,
    p_type: QBO_DISCONNECT,
    p_connection: input.connectionId,
    p_target: target,
    p_payload: payload,
    p_version: QBO_PAYLOAD_VERSION,
    p_hash: hash,
    p_rationale: null,
    p_source_refs: [],
    p_proposer_kind: "user",
    p_proposer_user: ctx.userId,
    p_derived: false,
  });
  if (error) throw toApprovalsError(error);
  if (typeof data !== "string" || !UUID.test(data)) throw new ApprovalsError("unavailable");
  await audit(deps, ctx.laneId, { kind: "user", userId: ctx.userId }, "action.proposed", data, {
    action_type: QBO_DISCONNECT,
    connection_id: input.connectionId,
    hash,
    proposer_kind: "user",
    derived_from_retrieved: false,
  });
  return { id: data, hash };
}

class TamperError extends Error {
  override readonly name = "TamperError";
}

type Stage = "before" | "revoke" | "verify";
type FailureOutcome = "error" | "outcome_unknown";

/** Connector error kinds after which Intuit certainly did nothing or the tokens were kept (a new proposal is safe). */
function failureOf(e: unknown, stage: Stage): { code: string; outcome: FailureOutcome } {
  if (e instanceof TamperError) return { code: "payload_changed", outcome: "error" };
  if (stage === "verify") {
    if (isConnectorError(e) && e.info.message === QBO_VERIFICATION_MISMATCH_MESSAGE) return { code: "verification_mismatch", outcome: "outcome_unknown" };
    return { code: "verification_unavailable", outcome: "outcome_unknown" };
  }
  if (isConnectorError(e)) {
    if (e.info.kind === "reconnect_required" || e.info.kind === "connection_unavailable") return { code: "connection_unhealthy", outcome: "error" };
    if (["forbidden", "invalid_input", "lane_mismatch", "unsupported_op"].includes(e.info.kind)) return { code: "execution_refused", outcome: "error" };
  }
  return { code: "execution_error", outcome: "error" };
}

/**
 * Approves the exact payload the person saw and carries it out once. The caller (the route) has done requireRole(owner or
 * admin_technical) and requireStepUp(step_up_max_age_s); the database checks both again. Returns what happened; throws
 * ApprovalsError for a refusal before anything was done (hash mismatch, not enabled, not live, expired, already approved, ...).
 */
export async function approveAndExecuteQbo(deps: QboExecDeps, ctx: UserCtx, input: { actionId: string; hashSeen: string }): Promise<ApproveResult> {
  checkLane(ctx.laneId);
  checkId(input.actionId);
  if (typeof input.hashSeen !== "string" || !/^[0-9a-f]{64}$/.test(input.hashSeen)) throw new ApprovalsError("invalid");
  const actor = { kind: "user" as const, userId: ctx.userId };
  const blocked = async (reason: string): Promise<never> => {
    await audit(deps, ctx.laneId, actor, "action.gate_blocked", input.actionId, { reason }).catch(() => undefined);
    throw new ApprovalsError(reason as ApprovalsError["code"]);
  };
  const row = await getRow(ctx.rpc, ctx.laneId, input.actionId);
  if (row.actionType !== QBO_DISCONNECT) throw new ApprovalsError("invalid");
  await requireRole(ctx);

  if (row.status === "approved") {
    // Resume: approved by this person for this exact hash but never carried out (a killed request after act_approve). The single
    // claim keeps it to one execution; the gates run again.
    if (row.approvedBy !== ctx.userId || row.approvedHash !== row.payloadSha256 || input.hashSeen !== row.payloadSha256 || hashOfRow(row) !== row.payloadSha256) return blocked("already_approved");
    const capNow = capabilityOf(ctx.laneId, await deps.readFacts(ctx.laneId, row.connectionId), row.actionType);
    if (!capNow.enabled) return blocked(capNow.reason === "not_live" ? "not_live" : "qbo_not_enabled");
    await audit(deps, ctx.laneId, actor, "action.resumed", row.id, { action_type: row.actionType, hash: row.payloadSha256 });
    return executeApprovedQbo(deps, ctx.laneId, row.id);
  }
  if (row.status !== "proposed") return blocked("not_pending");
  if (hashOfRow(row) !== row.payloadSha256 || input.hashSeen !== row.payloadSha256) return blocked("hash_mismatch");
  const cap = capabilityOf(ctx.laneId, await deps.readFacts(ctx.laneId, row.connectionId), row.actionType);
  if (!cap.enabled) return blocked(cap.reason === "not_live" ? "not_live" : "qbo_not_enabled");

  const approved = await ctx.rpc("act_approve", { p_lane: ctx.laneId, p_id: row.id, p_hash_seen: input.hashSeen });
  if (approved.error) {
    const e = toApprovalsError(approved.error);
    const err = e.code === "not_enabled" ? new ApprovalsError("qbo_not_enabled") : e;
    await audit(deps, ctx.laneId, actor, "action.gate_blocked", row.id, { reason: err.code }).catch(() => undefined);
    throw err;
  }
  await audit(deps, ctx.laneId, actor, "action.approved", row.id, { action_type: row.actionType, hash: row.payloadSha256 });
  return executeApprovedQbo(deps, ctx.laneId, row.id);
}

/**
 * approved -> executing (the single claim) -> revoke at Intuit -> read back -> verified or failed. A second call finds the claim
 * taken and returns `already_in_progress` without touching Intuit.
 */
export async function executeApprovedQbo(deps: QboExecDeps, laneId: LaneId, actionId: string): Promise<ApproveResult> {
  const job = await deps.jobRpc(laneId);
  // "An unaudited action never runs": the start is written before the claim and before any external call.
  await audit(deps, laneId, { kind: "service" }, "action.execute_started", actionId, {});
  const claimed = await job("act_claim_execution", { p_lane: laneId, p_id: actionId });
  if (claimed.error) {
    const err = toApprovalsError(claimed.error);
    if (err.code === "in_progress" || err.code === "not_pending") return { status: "already_in_progress", actionId };
    await audit(deps, laneId, { kind: "service" }, "action.gate_blocked", actionId, { reason: err.code === "not_enabled" ? "qbo_not_enabled" : err.code }).catch(() => undefined);
    throw err.code === "not_enabled" ? new ApprovalsError("qbo_not_enabled") : err;
  }
  const row = firstRow(claimed.data);
  // The hash and the approver are the ones the database recorded on the locked row, never a caller's word.
  const approvedBy = row.approvedBy;

  let stage: Stage = "before";
  let verified = false;
  let outcome: "accepted" | "already_applied" = "accepted";
  const externalId = qboExternalId(row.connectionId);
  try {
    if (row.actionType !== QBO_DISCONNECT || row.laneId !== laneId) throw new TamperError();
    if (hashOfRow(row) !== row.payloadSha256 || row.approvedHash !== row.payloadSha256) throw new TamperError();
    if (typeof approvedBy !== "string" || !UUID.test(approvedBy)) throw new TamperError();
    const keys = Object.keys(row.target);
    if (keys.length !== 1 || keys[0] !== "realm_id" || typeof row.target.realm_id !== "string" || Object.keys(row.payload).length !== 0) throw new TamperError();
    const action: QboApprovedAction = {
      id: row.id,
      lane_id: laneId,
      connection_id: row.connectionId,
      action_type: row.actionType,
      target: row.target as QboApprovedAction["target"],
      payload: row.payload as QboApprovedAction["payload"],
      payload_schema_version: row.payloadSchemaVersion,
      payload_sha256: row.payloadSha256,
      approved_by: approvedBy,
    };
    const conn = await deps.loadWriteConnection(laneId, row.connectionId);
    stage = "revoke";
    const res = await deps.writer.executeWrite(laneId, conn, action);
    outcome = res.outcome;
    stage = "verify";
    const sent = await job("act_claim_sent", { p_lane: laneId, p_id: actionId, p_external_id: externalId });
    if (sent.error) throw toApprovalsError(sent.error);
    await deps.verifier.verify(laneId, conn, action);
    verified = true;
    const done = await job("act_mark_verified", { p_lane: laneId, p_id: actionId, p_external_id: externalId, p_outcome: outcome });
    if (done.error) throw toApprovalsError(done.error);
  } catch (e) {
    // An execute that lost a race to the reconciler: the row is already finished. Report what the database says.
    const settled = await settledState(job, laneId, actionId);
    if (settled) return settled;
    if (verified) {
      // Revoked and read back; only recording it failed. Never turn a done disconnect into "failed": the row stays executing
      // with its claim at "sent" and the reconcile sweep finishes it.
      console.error("[approvals] verified disconnect could not be recorded", { laneId, actionId });
      await audit(deps, laneId, { kind: "service" }, "action.record_failed", actionId, { external_id: externalId }).catch(() => undefined);
      return { status: "verified", actionId };
    }
    const f = failureOf(e, stage);
    let marked: Awaited<ReturnType<Rpc>>;
    try {
      marked = await job("act_mark_failed", { p_lane: laneId, p_id: actionId, p_code: f.code, p_outcome: f.outcome });
    } catch {
      marked = { data: null, error: { message: "mark_failed unavailable" } };
    }
    if (marked.error) {
      const after = await settledState(job, laneId, actionId);
      if (after) return after;
      await audit(deps, laneId, { kind: "service" }, "action.failed", actionId, { failure: f.code, outcome: f.outcome }).catch(() => undefined);
      throw new ApprovalsError("unavailable");
    }
    await audit(deps, laneId, { kind: "service" }, "action.failed", actionId, { failure: f.code, outcome: f.outcome }).catch(() => undefined);
    return { status: "failed", actionId, failureCode: f.code };
  }
  await audit(deps, laneId, { kind: "service" }, "action.verified", actionId, { outcome, external_id: externalId }).catch(() => undefined);
  return { status: "verified", actionId };
}

export type { ActionRow };
