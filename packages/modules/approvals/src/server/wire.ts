// The approvals module over the real lane router, audit and Google connector (T-232). Server only; a separate subpath
// (`@nichols/approvals/wire`) so tests of the module logic never import the connector wiring. The job client bypasses RLS:
// every call below passes the lane and the database re-checks it (act.* functions are lane-scoped definer functions).
import { prepareEmailWrite, laneMailboxes } from "@nichols/connectors/google";
import { googleEmailWriter, loadGoogleWriteConnection } from "@nichols/connectors/write";
import type { LaneId } from "@nichols/core";
import { getAudit, getLaneClient, getLaneJobClient } from "@nichols/core/lane-router";
import type { CapabilityFacts, ApprovalsDeps, Rpc } from "./types";

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
  const approvals = ((config.data?.config as { approvals?: Record<string, unknown> } | null | undefined)?.approvals ?? {}) as Record<string, unknown>;
  const age = approvals.step_up_max_age_s;
  return {
    mailbox: usable ? c.external_account_id.toLowerCase() : null,
    composeGranted: usable && c.features?.gmail_compose === true,
    writeActionsAllowed: ((policy.data?.write_actions_allowed as string[] | undefined) ?? []).filter((x) => typeof x === "string"),
    approvalsLive: approvals.approvals_live === true,
    stepUpMaxAgeS: typeof age === "number" && Number.isInteger(age) && age >= 30 && age <= 900 ? age : 300,
  };
}

export const approvalsDeps: ApprovalsDeps = {
  jobRpc,
  prepareEmailWrite,
  laneMailboxes,
  readFacts,
  loadWriteConnection: loadGoogleWriteConnection,
  writer: googleEmailWriter,
  audit: getAudit(),
};

/** The signed-in user's own (RLS) rpc for a lane, through the lane router: a lane the user may not open has no client. */
export async function userRpc(laneId: LaneId, session: Parameters<typeof getLaneClient>[1]): Promise<Rpc> {
  return rpcOf((await getLaneClient(laneId, session)) as never);
}
