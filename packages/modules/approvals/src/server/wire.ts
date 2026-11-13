import "server-only";
// The approvals module over the real lane router, audit and Google connector (T-232). Server only; a separate subpath
// (`@nichols/approvals/wire`) so tests of the module logic never import the connector wiring. The job client bypasses RLS:
// every call below passes the lane and the database re-checks it (act.* functions are lane-scoped definer functions).
import { prepareEmailWrite, laneMailboxes } from "@nichols/connectors/google";
import { googleEmailReconciler, googleEmailWriter, loadGoogleWriteConnection, loadQuickbooksWriteConnection, quickbooksDisconnectVerifier, quickbooksWriter } from "@nichols/connectors/write";
import type { LaneId } from "@nichols/core";
import { getAudit, getLaneJobClient } from "@nichols/core/lane-router";
import { approveAndExecute, executeApproved, proposeEmailAction, type ProposeEmailInput } from "./email";
import { approveAndExecuteQbo, executeApprovedQbo, type QboExecDeps } from "./qbo";
import { reconcileStuckActions, type ReconcileDeps, type ReconcileSummary } from "./reconcile";
import { createEmailReconciler } from "./reconcile-email";
import { createQboReconciler } from "./reconcile-qbo";
import { getRow } from "./email";
import { isEmailType } from "./types";
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
    core.from("connections").select("provider, external_account_id, status, features").eq("lane_id", laneId).eq("id", connectionId).maybeSingle(),
    core.from("lane_policies").select("write_actions_allowed").eq("lane_id", laneId).maybeSingle(),
    core.from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle(),
  ]);
  if (conn.error || policy.error || config.error) throw new Error("capability facts unavailable");
  const c = conn.data as { provider: string; external_account_id: string; status: string; features: Record<string, unknown> } | null;
  const usable = c !== null && c.provider === "google" && (c.status === "active" || c.status === "degraded");
  // T-195: a QuickBooks connection of the lane that is not disconnected (reconnect_required can still be disconnected).
  const qboOk = c !== null && c.provider === "quickbooks" && c.status !== "disconnected" && c.status !== "pending";
  const approvals = ((config.data?.config as { approvals?: Record<string, unknown> } | null | undefined)?.approvals ?? {}) as Record<string, unknown>;
  const age = approvals.step_up_max_age_s;
  return {
    mailbox: usable ? c.external_account_id.toLowerCase() : null,
    qbo: qboOk ? { realmId: c.external_account_id } : null,
    composeGranted: usable && c.features?.gmail_compose === true,
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
  prepareEmailWrite,
  laneMailboxes,
  readFacts,
  audit: getAudit(),
});

const fullDeps: ApprovalsDeps = Object.freeze({
  ...approvalsDeps,
  loadWriteConnection: loadGoogleWriteConnection,
  writer: googleEmailWriter,
});

/** The QuickBooks disconnect executor's deps (T-195): the approvals-only writer and the read-back verifier, private to this file. */
const qboDeps: QboExecDeps = Object.freeze({
  ...approvalsDeps,
  loadWriteConnection: loadQuickbooksWriteConnection as QboExecDeps["loadWriteConnection"],
  writer: quickbooksWriter as unknown as QboExecDeps["writer"],
  verifier: quickbooksDisconnectVerifier as QboExecDeps["verifier"],
});

/**
 * Approve the exact hash the person saw, then carry it out once (the route calls this after requireRole + requireStepUp).
 * The action's own type picks the executor: an email goes through the Gmail writer, `qbo.disconnect` (T-195) through the
 * QuickBooks writer. The type is read from the action row (RLS: the caller must be able to see it), never from the request.
 */
export async function approveAndExecuteAction(ctx: UserCtx, input: { actionId: string; hashSeen: string }) {
  const row = await getRow(ctx.rpc, ctx.laneId, input.actionId);
  return isEmailType(row.actionType) ? approveAndExecute(fullDeps, ctx, input) : approveAndExecuteQbo(qboDeps, ctx, input);
}
/** Same function under its T-232 name (emails were the only action type then). */
export const approveAndExecuteEmail = approveAndExecuteAction;

/** Carries out an action already approved in the database (a job or a resume); the approver is read from the row. */
export function executeApprovedEmail(laneId: Parameters<typeof executeApproved>[1], actionId: string) {
  return executeApproved(fullDeps, laneId, actionId);
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
    createEmailReconciler({ reconciler: googleEmailReconciler, loadWriteConnection: loadGoogleWriteConnection }),
    createQboReconciler({ verifier: quickbooksDisconnectVerifier as QboExecDeps["verifier"], loadWriteConnection: loadQuickbooksWriteConnection as QboExecDeps["loadWriteConnection"] }),
  ]),
});
export function reconcileStuckLane(laneId: LaneId): Promise<ReconcileSummary> {
  return reconcileStuckActions(reconcileDeps, laneId);
}

/**
 * The briefing's one entry point (T-231d security review L2): a job proposal for the owner, bound to the real deps, so
 * the briefing never holds `approvalsDeps` (whose jobRpc is the service-role rpc). Proposes only; never approves or sends.
 */
export async function proposeBriefingReply(laneId: LaneId, ownerUserId: string, input: Pick<ProposeEmailInput, "connectionId" | "compose" | "rationale" | "sourceRefs" | "signal">): Promise<string> {
  const { id } = await proposeEmailAction(approvalsDeps, laneId, {
    ...input,
    actionType: "email.send",
    proposerKind: "job",
    proposerUserId: ownerUserId,
    derivedFromRetrieved: true,
  });
  return id;
}
