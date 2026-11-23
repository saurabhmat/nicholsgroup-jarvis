import "server-only";
// The approvals module over the real lane router, audit and Google connector (T-232). Server only; a separate subpath
// (`@nichols/approvals/wire`) so tests of the module logic never import the connector wiring. The job client bypasses RLS:
// every call below passes the lane and the database re-checks it (act.* functions are lane-scoped definer functions).
import type { LaneBoundConnection } from "@nichols/connectors";
import { prepareEmailWrite, laneMailboxes, mailboxAllowed, providerGate } from "@nichols/connectors/facade";
import { GRAPH_MAIL_WRITE_FEATURE, emailWriteGate, googleEmailReconciler, googleEmailWriter, loadEmailWriteConnection, loadTeamsWriteConnection, microsoftEmailReconciler, microsoftEmailWriter, loadQuickbooksWriteConnection, quickbooksDisconnectVerifier, quickbooksWriter, teamsMessageReconciler, teamsMessageWriter } from "@nichols/connectors/write";
import type { LaneId } from "@nichols/core";
import { getAudit, getLaneJobClient } from "@nichols/core/lane-router";
import { createEmailWriteDispatch, type EmailWriteEntry } from "./email-dispatch";
import { approveAndExecute, executeApproved, proposeEmailAction, type ProposeEmailInput } from "./email";
import { isQboDisconnectable } from "./capability";
import { approveAndExecuteQbo, executeApprovedQbo, type QboExecDeps } from "./qbo";
import { reconcileStuckActions, type ReconcileDeps, type ReconcileSummary } from "./reconcile";
import { createBriefingReplyGate } from "./briefing-gate";
import { createEmailReconciler } from "./reconcile-email";
import { ApprovalsError } from "./errors";
import { createQboReconciler } from "./reconcile-qbo";
import { createTeamsReconciler } from "./reconcile-teams";
import { approveAndExecuteTeams, executeApprovedTeams, type TeamsExecDeps } from "./teams";
import { getRow } from "./email";
import { isEmailType, isTeamsType } from "./types";
import type { CapabilityFacts, ApprovalsDeps, ApprovalsPublicDeps, Rpc, UserCtx } from "./types";

const rpcOf = (client: { schema(name: "core"): { rpc: unknown } }): Rpc => {
  const core = client.schema("core") as unknown as { rpc: Rpc };
  return core.rpc.bind(core) as Rpc;
};

/** The rpc of the lane's service-role client. */
export async function jobRpc(laneId: LaneId): Promise<Rpc> {
  return rpcOf((await getLaneJobClient(laneId)) as never);
}

async function readFacts(laneId: LaneId, connectionId: string): Promise<CapabilityFacts> {
  const client = await getLaneJobClient(laneId);
  const core = client.schema("core");
  const [conn, policy, config] = await Promise.all([
    core.from("connections").select("provider, external_account_id, status, features, owner_user_id").eq("lane_id", laneId).eq("id", connectionId).maybeSingle(),
    core.from("lane_policies").select("write_actions_allowed").eq("lane_id", laneId).maybeSingle(),
    core.from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle(),
  ]);
  if (conn.error || policy.error || config.error) throw new Error("capability facts unavailable");
  const c = conn.data as { provider: string; external_account_id: string; status: string; features: Record<string, unknown>; owner_user_id: string | null } | null;
  // T-260: a connection whose provider the lane has not enabled (paused, D-57) is not usable, so Reply is not offered on it (it would be refused at prepare anyway).
  // T-263: both email providers have a writer; the gate is asked for the row's own provider. An unreadable config fails closed (not usable), never an error page.
  const emailProvider = c !== null && (c.provider === "google" || c.provider === "microsoft") ? c.provider : null;
  const providerOn = emailProvider !== null ? await providerGate.enabled(laneId, emailProvider).catch(() => false) : false;
  const usable = c !== null && emailProvider !== null && providerOn && (c.status === "active" || c.status === "degraded");
  // The write permission is recorded per provider at connect time: Google's `gmail_compose`, Microsoft's `graph_mail_write`.
  const grantFeature = emailProvider === "microsoft" ? GRAPH_MAIL_WRITE_FEATURE : "gmail_compose";
  // T-195: a QuickBooks connection of the lane that is not disconnected (reconnect_required can still be disconnected).
  const qboOk = c !== null && c.provider === "quickbooks" && isQboDisconnectable(c.status);
  const approvals = ((config.data?.config as { approvals?: Record<string, unknown> } | null | undefined)?.approvals ?? {}) as Record<string, unknown>;
  // T-286: a usable Teams connection of the lane, and whether the lane's `teams` block (enabled + features) and the connection's own send permission both allow a chat send and a channel send.
  const teamsCfg = (config.data?.config as { teams?: { enabled?: unknown; features?: unknown } } | null | undefined)?.teams;
  const teamsLane = (feature: string): boolean => teamsCfg?.enabled === true && Array.isArray(teamsCfg.features) && teamsCfg.features.includes(feature);
  const teamsUsable = c !== null && c.provider === "microsoft_teams" && (c.status === "active" || c.status === "degraded");
  const age = approvals.step_up_max_age_s;
  return {
    mailbox: usable ? c.external_account_id.toLowerCase() : null,
    provider: usable ? emailProvider : null,
    qbo: qboOk ? { realmId: c.external_account_id } : null,
    teams: teamsUsable ? { ownerUserId: c.owner_user_id, chatSend: teamsLane("chat_send") && c.features?.teams_chat_send === true, channelsSend: teamsLane("channels_send") && c.features?.teams_channels_send === true } : null,
    composeGranted: usable && c.features?.[grantFeature] === true,
    writeActionsAllowed: ((policy.data?.write_actions_allowed as string[] | undefined) ?? []).filter((x) => typeof x === "string"),
    approvalsLive: approvals.approvals_live === true,
    stepUpMaxAgeS: typeof age === "number" && Number.isInteger(age) && age >= 30 && age <= 900 ? age : 300,
  };
}

/**
 * What request code may hold: propose, edit, reject, list, capability (T-232 security review H1). No write member: the
 * Gmail writer and the write-connection loader stay in `fullDeps` below, private to this file.
 */
export const approvalsDeps: ApprovalsPublicDeps = Object.freeze({
  jobRpc,
  // T-255, T-262: through the facade (by the connection row's provider).
  prepareEmailWrite: prepareEmailWrite as ApprovalsPublicDeps["prepareEmailWrite"],
  laneMailboxes,
  mailboxAllowed,
  readFacts,
  audit: getAudit(),
});

// T-255, T-263: the email writer, the write-connection loader and the reconciler's read side go by the connection row's provider (never a lane-level
// value) and refuse a provider the lane has not enabled, before any token read. A lane with both providers executes a Google and a Microsoft proposal each with
// its own writer. The reconciler is handed `findWrite` and `verifyWrite` only (the dispatch's other member is not exposed to it); each provider's reconciler read
// side has no `executeWrite` at all.
const googleEmailEntry: EmailWriteEntry = {
  actionTypes: googleEmailWriter.actionTypes,
  executeWrite: (laneId, conn, action) => googleEmailWriter.executeWrite(laneId, conn as LaneBoundConnection<"google">, action),
  verifyWrite: (laneId, conn, action, externalId) => googleEmailReconciler.verifyWrite(laneId, conn as LaneBoundConnection<"google">, action, externalId),
  findWrite: (laneId, conn, action) => googleEmailReconciler.findWrite(laneId, conn as LaneBoundConnection<"google">, action),
};
Object.freeze(googleEmailEntry);
const microsoftEmailEntry: EmailWriteEntry = {
  actionTypes: microsoftEmailWriter.actionTypes,
  sentCopyMayLagDeclared: microsoftEmailWriter.sentCopyMayLag,
  executeWrite: (laneId, conn, action) => microsoftEmailWriter.executeWrite(laneId, conn as LaneBoundConnection<"microsoft">, action),
  verifyWrite: (laneId, conn, action, externalId) => microsoftEmailReconciler.verifyWrite(laneId, conn as LaneBoundConnection<"microsoft">, action, externalId),
  findWrite: (laneId, conn, action) => microsoftEmailReconciler.findWrite(laneId, conn as LaneBoundConnection<"microsoft">, action),
};
Object.freeze(microsoftEmailEntry);
const emailDispatch = createEmailWriteDispatch({ loader: { loadConnection: loadEmailWriteConnection }, gate: emailWriteGate, entries: { google: googleEmailEntry, microsoft: microsoftEmailEntry } });
const emailReconcilerReadSide = Object.freeze({ findWrite: emailDispatch.writer.findWrite, verifyWrite: emailDispatch.writer.verifyWrite });

const fullDeps: ApprovalsDeps = Object.freeze({
  ...approvalsDeps,
  // T-255, T-263: dispatched by the connection row's provider.
  loadWriteConnection: emailDispatch.loadWriteConnection,
  writer: emailDispatch.writer,
});

/** The QuickBooks disconnect executor's deps (T-195): the approvals-only writer and the read-back verifier, private to this file. */
const qboDeps: QboExecDeps = Object.freeze({
  ...approvalsDeps,
  loadWriteConnection: loadQuickbooksWriteConnection as QboExecDeps["loadWriteConnection"],
  writer: quickbooksWriter as unknown as QboExecDeps["writer"],
  verifier: quickbooksDisconnectVerifier as QboExecDeps["verifier"],
});

/**
 * The Teams message executor's deps (T-286, T-287): the approvals-only writer and the Teams connection loader, private to this file (like the email writer). Reached only through
 * `approveAndExecuteTeamsAction` / `executeApprovedTeamsAction` below, which no route, page, job or tool calls yet (T-288 adds the one that does, after D-67).
 */
const teamsWriter: TeamsExecDeps["writer"] = Object.freeze({
  executeWrite: (laneId, conn, action) => teamsMessageWriter.executeWrite(laneId, conn, action),
  verifyWrite: (laneId, conn, action, externalId, window) => teamsMessageReconciler.verifyWrite(laneId, conn, action, externalId, window),
});
const teamsDeps: TeamsExecDeps = Object.freeze({ ...approvalsDeps, loadWriteConnection: loadTeamsWriteConnection, writer: teamsWriter });

/**
 * Approve the exact hash the person saw, then carry it out once (the route calls this after requireRole + requireStepUp).
 * The action's own type picks the executor: an email goes through the Gmail writer, `qbo.disconnect` (T-195) through the
 * QuickBooks writer. The type is read from the action row (RLS: the caller must be able to see it), never from the request.
 */
export async function approveAndExecuteAction(ctx: UserCtx, input: { actionId: string; hashSeen: string }) {
  const row = await getRow(ctx.rpc, ctx.laneId, input.actionId);
  // A Teams message is approved only through its own entry (approveAndExecuteTeamsAction: its own step-up window, D-67); the generic approvals route never sends one.
  if (isTeamsType(row.actionType)) throw new ApprovalsError("invalid");
  return isEmailType(row.actionType) ? approveAndExecute(fullDeps, ctx, input) : approveAndExecuteQbo(qboDeps, ctx, input);
}
/** Same function under its T-232 name (emails were the only action type then). */
export const approveAndExecuteEmail = approveAndExecuteAction;

/** Carries out an action already approved in the database (a job or a resume); the approver is read from the row. */
export function executeApprovedEmail(laneId: Parameters<typeof executeApproved>[1], actionId: string) {
  return executeApproved(fullDeps, laneId, actionId);
}

/** Approves a Teams message the person pressed Send on and carries it out once (T-286, T-287; the one-step `sendTeamsMessage` of T-288 calls this after its own checks). Not called by anything yet. */
export function approveAndExecuteTeamsAction(ctx: UserCtx, input: { actionId: string; hashSeen: string }) {
  return approveAndExecuteTeams(teamsDeps, ctx, input);
}

/** Carries out a Teams message already approved in the database (a resume); the approver is read from the row. */
export function executeApprovedTeamsAction(laneId: Parameters<typeof executeApprovedTeams>[1], actionId: string) {
  return executeApprovedTeams(teamsDeps, laneId, actionId);
}

/** Carries out a QuickBooks disconnect already approved in the database (a resume); the approver is read from the row. */
export function executeApprovedDisconnect(laneId: Parameters<typeof executeApprovedQbo>[1], actionId: string) {
  return executeApprovedQbo(qboDeps, laneId, actionId);
}


/** action.expire (security review M2): expires the lane's stale actions (bodies removed in the same statement). */
export async function expireStaleActions(laneId: LaneId): Promise<number> {
  const { data, error } = await (await jobRpc(laneId))("act_expire_stale", { p_lane: laneId });
  if (error || typeof data !== "number") throw new Error("action expiry failed");
  return data;
}

/**
 * action.reconcile_stuck (T-192): one sweep of one lane. Verify-only: the handlers hold the connector's marker lookup and
 * read-back (no executeWrite) and the database functions never create a claim. Add other types (monday) as more handlers.
 */
const reconcileDeps: ReconcileDeps = Object.freeze({
  jobRpc,
  audit: approvalsDeps.audit,
  reconcilers: Object.freeze([
    createEmailReconciler({ reconciler: emailReconcilerReadSide, loadWriteConnection: emailDispatch.loadWriteConnection }),
    createQboReconciler({ verifier: quickbooksDisconnectVerifier as QboExecDeps["verifier"], loadWriteConnection: loadQuickbooksWriteConnection as QboExecDeps["loadWriteConnection"] }),
    // T-287: Teams messages are looked up and read back (find + verify only: this read side has no executeWrite).
    createTeamsReconciler({ reconciler: Object.freeze({ findWrite: teamsMessageReconciler.findWrite, verifyWrite: teamsMessageReconciler.verifyWrite }), loadWriteConnection: loadTeamsWriteConnection }),
  ]),
});
export function reconcileStuckLane(laneId: LaneId): Promise<ReconcileSummary> {
  return reconcileStuckActions(reconcileDeps, laneId);
}

/**
 * The briefing's one entry point (T-231d security review L2): a job proposal for the owner, bound to the real deps, so
 * the briefing never holds `approvalsDeps` (whose jobRpc is the service-role rpc). Proposes only; never approves or sends.
 */
const briefingGate = createBriefingReplyGate({ loadWriteConnection: emailDispatch.loadWriteConnection, readFacts });
/** Whether the briefing may propose a reply for this connection (its provider and its write grant; unknown: no). Read-only. */
export const briefingReplyAllowed = (laneId: LaneId, connectionId: string): Promise<boolean> => briefingGate(laneId, connectionId);

export async function proposeBriefingReply(laneId: LaneId, ownerUserId: string, input: Pick<ProposeEmailInput, "connectionId" | "compose" | "rationale" | "sourceRefs" | "signal">): Promise<string> {
  // Defence in depth: the same gate again here, so no caller can propose for a connection whose provider or grant is not known to allow it.
  if (!(await briefingGate(laneId, input.connectionId))) throw new ApprovalsError("not_enabled", "Sending isn't enabled for this mailbox yet.");
  const { id } = await proposeEmailAction(approvalsDeps, laneId, {
    ...input,
    actionType: "email.send",
    proposerKind: "job",
    proposerUserId: ownerUserId,
    derivedFromRetrieved: true,
  });
  return id;
}
