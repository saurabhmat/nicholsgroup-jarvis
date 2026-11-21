// The Microsoft health check (T-256): `GET /me` through the guarded Graph client, registered with conn.token_health (health/index.ts).
// Read-only; it reports and does not throw for connection problems (same shape as the QuickBooks check). Only a status and a
// scrubbed error leave: nothing from the /me response is kept (it holds a name and an address), and no token is touched here.
import type { LaneId } from "@nichols/core";
import { toConnectorError } from "../contract/errors";
import type { HealthStatus } from "../contract/schemas";
import type { GraphApi } from "./api";

export type MicrosoftHealthDeps = { api: GraphApi; now?: () => number };

export function createMicrosoftHealth(deps: MicrosoftHealthDeps) {
  const now = deps.now ?? Date.now;
  return async function health(laneId: LaneId, conn: unknown): Promise<HealthStatus> {
    const checked_at = new Date(now()).toISOString();
    try {
      // The guard (inside `get`) refuses a connection that is not usable, not enabled for the lane, or from a removed tenant.
      const res = await deps.api.get(laneId, conn, "/me", undefined, { $select: "id" });
      return { ok: true, status: "active", checked_at, provider_tid: res.providerTid, error: null };
    } catch (e) {
      const err = toConnectorError(e);
      return { ok: false, status: err.info.kind === "reconnect_required" ? "reconnect_required" : "degraded", checked_at, provider_tid: err.info.provider_tid, error: err.toJSON() };
    }
  };
}
