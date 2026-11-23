// The Teams health check (T-279): `GET /me` (`$select=id`) through the guarded Teams client, registered with conn.token_health (health/index.ts). Read-only; it reports and does not
// throw for connection problems (same shape as the Microsoft mail check). Only a status and a scrubbed error leave: nothing from the /me response is kept (it holds a name).
import type { LaneId } from "@nichols/core";
import { toConnectorError } from "../contract/errors";
import type { HealthStatus } from "../contract/schemas";
import type { LaneConfigReader } from "../vault/lane-config";
import type { TeamsApi } from "./api";
import { teamsLaneProblem } from "./guard";

export type TeamsHealthDeps = { api: TeamsApi; now?: () => number };

export function createTeamsHealth(deps: TeamsHealthDeps) {
  const now = deps.now ?? Date.now;
  return async function health(laneId: LaneId, conn: unknown): Promise<HealthStatus> {
    const checked_at = new Date(now()).toISOString();
    try {
      // The guard (inside `get`) refuses a connection that is not usable, not enabled for the lane, or from a removed tenant.
      const res = await deps.api.get(laneId, conn, { path: "/me", query: { $select: "id" }, actor: { kind: "service" } });
      return { ok: true, status: "active", checked_at, provider_tid: res.providerTid, error: null };
    } catch (e) {
      const err = toConnectorError(e);
      return { ok: false, status: err.info.kind === "reconnect_required" ? "reconnect_required" : "degraded", checked_at, provider_tid: err.info.provider_tid, error: err.toJSON() };
    }
  };
}

/**
 * Whether the daily health job should skip a Teams connection: Teams is switched off for the lane (no `teams` block, or `enabled` false) or the lane is on a cloud this build does not
 * serve yet. That is a configuration choice, not a fault, so the job changes nothing and raises nothing. One `teamsSettings` read, no Vault read and no request. A removed tenant is NOT
 * skipped: it stays a real failure through the guard. A failed read throws, which the job reports as a retryable failure without touching the connection.
 */
export function createTeamsHealthSkip(deps: { laneConfig: Pick<LaneConfigReader, "teamsSettings"> }) {
  return async function skip(laneId: LaneId): Promise<boolean> {
    return teamsLaneProblem(await deps.laneConfig.teamsSettings(laneId)) !== null;
  };
}
