// The Approval Center for Teams messages (T-286, T-287; docs/specs/messages.md section 10; decision D-65): `teams.chat.send`, `teams.channel.post`, `teams.channel.reply`. Same life cycle and the same
// database functions as email and qbo.disconnect, with these differences:
//   * who: only the OWNER of the Teams connection proposes, approves, rejects and causes execution of a `teams.*` action, and only they can read it (the database checks every one of these again).
//   * what: target = the place + the client request id, payload = `{ content_type: "text", text }` and nothing else. The text is held in the proposal only while the action is open (rule 6, D-19 (a),
//     `store_outbound_drafts`); the database removes it with every terminal transition. The hash is over the exact payload that is sent; `executeApprovedTeams` refuses to send when the stored
//     content no longer hashes to the approved hash.
//   * the gates are the same as email, at propose, at approve and at claim (database) and here before each step: the lane policy class `teams_send`, the lane's `teams` block and the connection's
//     send permission, and `approvals_live`.
//   * ONE POST: the single execution claim (primary key) lets exactly one caller reach the writer; the writer sends one POST with no retry; after an unknown outcome it only looks the message up.
//     A second `executeApprovedTeams` finds the claim taken and returns `already_in_progress` without touching Microsoft.
//   * NOT built here (T-288, waits for D-67): the one-step "Send = your approval" (`sendTeamsMessage`), its route and the composer. Nothing in the app calls these functions yet.
// Failure semantics: a definite refusal (400, 403, 404, 413, 429, a guard refusal) is a plain failed action: nothing was sent. An unknown outcome is NEVER a plain failure and NEVER a resend: the writer
// looks the message up (one match = verified `already_applied`, several = failed `ambiguous_match`, none = the action stays `executing`, `outcome_pending`) and the reconcile sweep takes over.
// An accepted message that cannot be read back yet stays `executing` with its claim at "sent" (`sent_unverified`). Only a read-back that shows DIFFERENT text ends the action failed.
// Retrieved content never approves or executes anything: a proposal exists only because a person pressed Send; `aiDrafted` is stored as `derived_from_retrieved` and changes nothing else.
import { isConnectorError } from "@nichols/connectors";
import {
  TEAMS_PAYLOAD_VERSION,
  isTeamsActionType,
  normalizeTeamsText,
  parseTeamsSend,
  teamsFailureCodeOf,
  teamsProposalContent,
  type TeamsApprovedAction,
  type TeamsSend,
  type TeamsSendFailureCode,
} from "@nichols/connectors/write";
import type { LaneId } from "@nichols/core";
import { capabilityOf } from "./capability";
import { audit, checkId, checkLane, getRow, settledState, type ApproveResult, type ProposeResult } from "./email";
import { ApprovalsError, toApprovalsError } from "./errors";
import { firstRow, hashOfRow } from "./rows";
import { WRITE_ROLES, isTeamsType, type ActionRow, type ApprovalsPublicDeps, type Rpc, type TeamsConn, type TeamsWriteSurface, type UserCtx } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** What the executor needs besides the public deps: the write path, kept private to `wire.ts` like the email writer. */
export type TeamsExecDeps = ApprovalsPublicDeps & {
  loadWriteConnection(laneId: LaneId, connectionId: string): Promise<TeamsConn>;
  writer: Pick<TeamsWriteSurface, "executeWrite" | "verifyWrite">;
};

/** Where a message goes. The chat or channel id is the one Graph gave the person's own reader. */
export type TeamsPlace =
  | { type: "teams.chat.send"; chatId: string }
  | { type: "teams.channel.post"; teamId: string; channelId: string }
  | { type: "teams.channel.reply"; teamId: string; channelId: string; replyToId: string };

export type ProposeTeamsInput = {
  connectionId: string;
  place: TeamsPlace;
  /** What the person typed. It is normalised here (line breaks, NFC, trimmed) and validated; the stored and sent text is the normalised one. */
  text: string;
  /** One per composed message (a lower-case UUID made by the browser): a double click or a retry is the same action, never a second message. */
  clientRequestId: string;
  /** True when the text came from an AI draft the person then sent (stored as `derived_from_retrieved`). */
  aiDrafted: boolean;
};

async function requireRole(ctx: UserCtx, type: keyof typeof WRITE_ROLES): Promise<void> {
  const { data, error } = await ctx.rpc("has_lane_role", { p_uid: ctx.userId, p_lane: ctx.laneId, p_roles: [...WRITE_ROLES[type]] });
  if (error) throw toApprovalsError(error);
  if (data !== true) throw new ApprovalsError("forbidden");
}

/** The normalised, validated send of an input (the text shown for approval and sent), or an `invalid` refusal. Never says anything about the text. */
export function buildTeamsSend(input: Pick<ProposeTeamsInput, "place" | "text" | "clientRequestId">): TeamsSend {
  const text = normalizeTeamsText(typeof input.text === "string" ? input.text : "");
  const p = input.place;
  const target =
    p.type === "teams.chat.send"
      ? { chat_id: p.chatId, client_request_id: input.clientRequestId }
      : p.type === "teams.channel.post"
        ? { team_id: p.teamId, channel_id: p.channelId, client_request_id: input.clientRequestId }
        : { team_id: p.teamId, channel_id: p.channelId, reply_to_id: p.replyToId, client_request_id: input.clientRequestId };
  const send = parseTeamsSend(p.type, target, { content_type: "text", text });
  if (send === null) throw new ApprovalsError("invalid");
  return send;
}

/**
 * Proposes sending one message from the signed-in person's own Teams connection. A person's own request (the database refuses any other proposer, a job included). Never executes: nothing is
 * sent until the owner approves the exact payload. The same `clientRequestId` returns the existing action (a double click is one action). Returns `{ id, hash }`: the hash is what the person approves.
 * Refusals: `invalid` (text or ids), `forbidden` (role), `not_found` (not their connection), `not_enabled` / `not_live` (a gate is off), `drafts_not_allowed` (the lane does not store outbound text).
 */
export async function proposeTeamsAction(deps: ApprovalsPublicDeps, ctx: UserCtx, input: ProposeTeamsInput): Promise<ProposeResult> {
  checkLane(ctx.laneId);
  checkId(input.connectionId);
  if (typeof ctx.userId !== "string" || !UUID.test(ctx.userId)) throw new ApprovalsError("invalid");
  if (typeof input.aiDrafted !== "boolean") throw new ApprovalsError("invalid");
  if (!isTeamsActionType(input.place?.type)) throw new ApprovalsError("invalid");
  const send = buildTeamsSend(input);
  await requireRole(ctx, send.type);
  const facts = await deps.readFacts(ctx.laneId, input.connectionId);
  // Only the owner of the connection proposes from it (another person's connection id gets the same answer as an unknown one).
  if (!facts.teams || facts.teams.ownerUserId !== ctx.userId) throw new ApprovalsError("not_found");
  const cap = capabilityOf(ctx.laneId, facts, send.type);
  if (!cap.enabled) throw new ApprovalsError(cap.reason, cap.message);
  const content = teamsProposalContent(send);
  const target = cloneJson(content.target);
  const payload = cloneJson(content.payload);
  const hash = hashOfRow({ laneId: ctx.laneId, actionType: send.type, connectionId: input.connectionId, target, payload, payloadSchemaVersion: TEAMS_PAYLOAD_VERSION });
  const rpc = await deps.jobRpc(ctx.laneId);
  const { data, error } = await rpc("act_propose", {
    p_lane: ctx.laneId,
    p_type: send.type,
    p_connection: input.connectionId,
    p_target: target,
    p_payload: payload,
    p_version: TEAMS_PAYLOAD_VERSION,
    p_hash: hash,
    p_rationale: null,
    p_source_refs: [],
    p_proposer_kind: "user",
    p_proposer_user: ctx.userId,
    p_derived: input.aiDrafted,
  });
  if (error) {
    const e = toApprovalsError(error);
    if (e.code === "drafts_not_allowed") throw new ApprovalsError("drafts_not_allowed", "This company does not store outbound drafts, so sending in Teams is off.");
    if (e.code === "not_enabled") throw new ApprovalsError("teams_not_enabled");
    throw e;
  }
  if (typeof data !== "string" || !UUID.test(data)) throw new ApprovalsError("unavailable");
  // Ids, type and hash only: never the text.
  await audit(deps, ctx.laneId, { kind: "user", userId: ctx.userId }, "action.proposed", data, {
    action_type: send.type,
    connection_id: input.connectionId,
    hash,
    proposer_kind: "user",
    derived_from_retrieved: input.aiDrafted,
  });
  return { id: data, hash };
}

class TamperError extends Error {
  override readonly name = "TamperError";
}

type Stage = "before" | "send" | "verify";
type FailureOutcome = "mismatch" | "error" | "outcome_unknown";

/** Connector error kinds from the writer that mean it refused before any request left (nothing was sent). */
const DEFINITE_KINDS: ReadonlySet<string> = new Set(["forbidden", "invalid_input", "lane_mismatch", "unsupported_op", "reconnect_required", "connection_unavailable", "rate_limited", "not_found"]);

/** The failure to record for an error before or during the send, or `null` when the outcome is unknown and the action must stay `executing` (never a plain failure, never a resend). */
function sendFailureOf(e: unknown): { code: string; outcome: FailureOutcome } | null {
  if (e instanceof TamperError) return { code: "payload_changed", outcome: "error" };
  const code: TeamsSendFailureCode | null = teamsFailureCodeOf(e);
  if (code === "outcome_pending") return null;
  if (code === "ambiguous_match") return { code, outcome: "outcome_unknown" };
  if (code !== null && code !== "verification_mismatch" && code !== "outcome_unknown" && code !== "verification_unavailable") return { code, outcome: "error" };
  if (isConnectorError(e) && DEFINITE_KINDS.has(e.info.kind)) {
    if (e.info.kind === "reconnect_required" || e.info.kind === "connection_unavailable") return { code: "connection_unhealthy", outcome: "error" };
    return { code: "execution_refused", outcome: "error" };
  }
  return null; // a timeout, a transport error, anything unclassified after the request may have left: look it up, do not guess
}

/**
 * Where a second request for the same send finds it: the settled state, or for an action still executing the claim's: "Sent, checking" (`sent_unverified`: the claim holds the message id) or `outcome_pending`
 * (nothing recorded yet: still sending, or the outcome is unknown), so the caller can tell "Sending", "Sent, checking" and "Outcome unknown" apart. An approved action not yet claimed is `already_in_progress`.
 */
async function stateOfAction(job: Rpc, laneId: LaneId, actionId: string): Promise<ApproveResult> {
  const { data, error } = await job("act_action_state", { p_lane: laneId, p_id: actionId });
  const row = !error && Array.isArray(data) ? (data[0] as { status?: unknown; failure_code?: unknown } | undefined) : undefined;
  if (!row) throw new ApprovalsError("unavailable");
  if (row.status === "verified") return { status: "verified", actionId };
  if (row.status === "failed") return { status: "failed", actionId, failureCode: typeof row.failure_code === "string" ? row.failure_code : "outcome_unknown" };
  if (row.status === "executing") {
    const c = await job("act_claim_outcome", { p_lane: laneId, p_id: actionId });
    return !c.error && c.data === "sent" ? { status: "sent_unverified", actionId } : { status: "outcome_pending", actionId };
  }
  if (row.status === "approved") return { status: "already_in_progress", actionId };
  throw new ApprovalsError("not_pending"); // proposed, rejected, expired, invalidated: not a send in flight
}

/**
 * The claim was refused with "not pending": the action is no longer approved. Say what it is: invalidated (a disconnect closed it between the approval and the claim) is a definite "nothing was sent";
 * expired likewise; anything else is where that send is (settled, executing, ...).
 */
async function notClaimedState(job: Rpc, laneId: LaneId, actionId: string): Promise<ApproveResult> {
  const { data, error } = await job("act_action_state", { p_lane: laneId, p_id: actionId });
  const status = !error && Array.isArray(data) ? (data[0] as { status?: unknown } | undefined)?.status : undefined;
  if (status === "invalidated") return { status: "failed", actionId, failureCode: "connection_disconnected" };
  if (status === "expired") return { status: "failed", actionId, failureCode: "expired" };
  try {
    return await stateOfAction(job, laneId, actionId);
  } catch {
    return { status: "already_in_progress", actionId };
  }
}

/** A failure before any request left (the stored content, the connection, a credential): nothing was sent, so it is always a definite, retryable failure. */
function beforeFailureOf(e: unknown): { code: string; outcome: FailureOutcome } {
  if (e instanceof TamperError) return { code: "payload_changed", outcome: "error" };
  if (isConnectorError(e) && (e.info.kind === "reconnect_required" || e.info.kind === "connection_unavailable")) return { code: "connection_unhealthy", outcome: "error" };
  return { code: "execution_refused", outcome: "error" };
}

/** The approved action as the writer takes it, from the claimed (locked) row: the hash and the approver are the ones the database recorded. */
export function teamsActionOf(laneId: LaneId, row: ActionRow, approvedBy: string): TeamsApprovedAction {
  return {
    id: row.id,
    lane_id: laneId as TeamsApprovedAction["lane_id"],
    connection_id: row.connectionId,
    action_type: row.actionType,
    target: row.target as TeamsApprovedAction["target"],
    payload: row.payload as TeamsApprovedAction["payload"],
    payload_schema_version: row.payloadSchemaVersion,
    payload_sha256: row.payloadSha256,
    approved_by: approvedBy,
  };
}

/**
 * Approves the exact payload the person saw and carries it out once. The caller has done requireRole and the step-up for the Teams window (D-67; T-288); the database checks both again.
 * Returns what happened; throws ApprovalsError for a refusal before anything was done (hash mismatch, not enabled, not live, expired, ...). Another request for the same, already settled action
 * gets its state back, never a second send.
 */
export async function approveAndExecuteTeams(deps: TeamsExecDeps, ctx: UserCtx, input: { actionId: string; hashSeen: string }): Promise<ApproveResult> {
  checkLane(ctx.laneId);
  checkId(input.actionId);
  if (typeof input.hashSeen !== "string" || !/^[0-9a-f]{64}$/.test(input.hashSeen)) throw new ApprovalsError("invalid");
  const actor = { kind: "user" as const, userId: ctx.userId };
  const blocked = async (reason: string): Promise<never> => {
    await audit(deps, ctx.laneId, actor, "action.gate_blocked", input.actionId, { reason }).catch(() => undefined);
    throw new ApprovalsError(reason as ApprovalsError["code"]);
  };
  const row = await getRow(ctx.rpc, ctx.laneId, input.actionId);
  if (!isTeamsType(row.actionType)) throw new ApprovalsError("invalid");
  await requireRole(ctx, row.actionType);
  if (row.status === "executing") return stateOfAction(await deps.jobRpc(ctx.laneId), ctx.laneId, row.id);
  if (row.status === "verified") return { status: "verified", actionId: row.id };
  if (row.status === "failed") return { status: "failed", actionId: row.id, failureCode: row.failureCode ?? "outcome_unknown" };

  const gates = async (): Promise<void> => {
    const facts = await deps.readFacts(ctx.laneId, row.connectionId);
    if (!facts.teams || facts.teams.ownerUserId !== ctx.userId) await blocked("not_found");
    const cap = capabilityOf(ctx.laneId, facts, row.actionType);
    if (!cap.enabled) await blocked(cap.reason === "not_live" ? "not_live" : "teams_not_enabled");
  };

  if (row.status === "approved") {
    // Resume: approved by this person for this exact hash but never carried out (a killed request after act_approve). The single claim keeps it to one execution; the gates run again.
    if (row.approvedBy !== ctx.userId || row.approvedHash !== row.payloadSha256 || input.hashSeen !== row.payloadSha256 || hashOfRow(row) !== row.payloadSha256) return blocked("already_approved");
    await gates();
    await audit(deps, ctx.laneId, actor, "action.resumed", row.id, { action_type: row.actionType, hash: row.payloadSha256 });
    return executeApprovedTeams(deps, ctx.laneId, row.id);
  }
  if (row.status !== "proposed") return blocked("not_pending");
  // The stored content must still hash to the stored hash, and the hash the approver saw must be that hash.
  if (hashOfRow(row) !== row.payloadSha256 || input.hashSeen !== row.payloadSha256) return blocked("hash_mismatch");
  await gates();

  const approved = await ctx.rpc("act_approve", { p_lane: ctx.laneId, p_id: row.id, p_hash_seen: input.hashSeen });
  if (approved.error) {
    const e = toApprovalsError(approved.error);
    // A concurrent request for the same send got there first (a double click): report where it is instead of failing.
    if (e.code === "already_approved" || e.code === "not_pending") return stateOfAction(await deps.jobRpc(ctx.laneId), ctx.laneId, row.id);
    const err = e.code === "not_enabled" ? new ApprovalsError("teams_not_enabled") : e;
    await audit(deps, ctx.laneId, actor, "action.gate_blocked", row.id, { reason: err.code }).catch(() => undefined);
    throw err;
  }
  await audit(deps, ctx.laneId, actor, "action.approved", row.id, { action_type: row.actionType, hash: row.payloadSha256 });
  return executeApprovedTeams(deps, ctx.laneId, row.id);
}

/**
 * approved -> executing (the single claim) -> ONE post -> read back -> verified or failed. A second call finds the claim taken and returns `already_in_progress` without touching Microsoft.
 */
export async function executeApprovedTeams(deps: TeamsExecDeps, laneId: LaneId, actionId: string): Promise<ApproveResult> {
  const job = await deps.jobRpc(laneId);
  // "An unaudited action never runs": the start is written before the claim and before any external call.
  await audit(deps, laneId, { kind: "service" }, "action.execute_started", actionId, {});
  const claimed = await job("act_claim_execution", { p_lane: laneId, p_id: actionId });
  if (claimed.error) {
    const err = toApprovalsError(claimed.error);
    if (err.code === "in_progress") return { status: "already_in_progress", actionId };
    if (err.code === "not_pending") return notClaimedState(job, laneId, actionId);
    const shown = err.code === "not_enabled" ? new ApprovalsError("teams_not_enabled") : err;
    await audit(deps, laneId, { kind: "service" }, "action.gate_blocked", actionId, { reason: shown.code }).catch(() => undefined);
    throw shown;
  }
  const row = firstRow(claimed.data);
  // The hash and the approver are the ones the database recorded on the locked row, never a caller's word.
  const approvedBy = row.approvedBy;

  let stage: Stage = "before";
  let verified = false;
  let sentRecorded = false;
  let externalId: string | null = null;
  let outcome: "accepted" | "already_applied" = "accepted";
  try {
    // Immediately before the external call: the stored content must still be what was approved.
    if (row.laneId !== laneId || !isTeamsType(row.actionType)) throw new TamperError();
    if (hashOfRow(row) !== row.payloadSha256 || row.approvedHash !== row.payloadSha256) throw new TamperError();
    if (typeof approvedBy !== "string" || !UUID.test(approvedBy)) throw new TamperError();
    if (parseTeamsSend(row.actionType, row.target, row.payload) === null) throw new TamperError();
    const action = teamsActionOf(laneId, row, approvedBy);
    const conn = await deps.loadWriteConnection(laneId, row.connectionId);
    stage = "send";
    const res = await deps.writer.executeWrite(laneId, conn, action);
    // executeWrite returned: the message exists (created by the POST, or found by the lookup). From here nothing is a definite "not sent".
    stage = "verify";
    if (res.external_id === null) throw new ApprovalsError("unavailable");
    externalId = res.external_id;
    outcome = res.outcome;
    const sent = await job("act_claim_sent", { p_lane: laneId, p_id: actionId, p_external_id: externalId });
    if (sent.error) throw toApprovalsError(sent.error);
    sentRecorded = true;
    // The id the POST returned is ours by construction: no clock window (sender, place and text are still compared).
    await deps.writer.verifyWrite(laneId, conn, action, externalId);
    verified = true;
    const done = await job("act_mark_verified", { p_lane: laneId, p_id: actionId, p_external_id: externalId, p_outcome: outcome });
    if (done.error) throw toApprovalsError(done.error);
  } catch (e) {
    // An execute that lost a race to the reconciler or the disconnect purge: the row is already finished. Report what the database says.
    const settled = await settledState(job, laneId, actionId);
    if (settled) {
      // The POST returned a message id but the action was closed under us (a disconnect, the sweep): record the id (ids only) so the message can be found, and report the settled state.
      if (externalId !== null && settled.status === "failed") await audit(deps, laneId, { kind: "service" }, "action.record_failed", actionId, { external_id: externalId, failure: settled.failureCode }).catch(() => undefined);
      return settled;
    }
    if (verified) {
      // Posted and read back; only recording it failed. Never turn a sent message into "failed": the row stays executing with its claim at "sent" and the sweep finishes it.
      console.error("[approvals] verified Teams message could not be recorded", { laneId, actionId });
      await audit(deps, laneId, { kind: "service" }, "action.record_failed", actionId, { external_id: externalId }).catch(() => undefined);
      return { status: "verified", actionId };
    }
    let f: { code: string; outcome: FailureOutcome } | null;
    if (stage === "before") f = beforeFailureOf(e);
    else if (stage === "verify") {
      // The message was accepted. Different text in the chat is a failure of the read-back; anything else (not there yet, a timeout, a limit, the claim not recorded) leaves the action
      // `executing` for the sweep, which reads it back by id. Never "failed", never a second post.
      if (teamsFailureCodeOf(e) === "verification_mismatch") f = { code: "verification_mismatch", outcome: "mismatch" };
      else {
        await audit(deps, laneId, { kind: "service" }, "action.verification_pending", actionId, { external_id: externalId }).catch(() => undefined);
        return sentRecorded ? { status: "sent_unverified", actionId } : { status: "outcome_pending", actionId };
      }
    } else {
      f = sendFailureOf(e);
      if (f === null) {
        await audit(deps, laneId, { kind: "service" }, "action.outcome_pending", actionId, {}).catch(() => undefined);
        return { status: "outcome_pending", actionId };
      }
    }
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
