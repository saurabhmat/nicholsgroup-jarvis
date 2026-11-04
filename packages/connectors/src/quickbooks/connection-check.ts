// The temporary connection test (T-198): one read-only CompanyInfo health check for a lane's QuickBooks connection,
// reduced to what the Settings page may show: a status, when it was checked and Intuit's request id (`intuit_tid`, for
// Intuit support). Never a token, the realm id or any company data. A GET only (rule 5); nothing is written, not even
// the connection's status. Removed or folded into T-045 (connection health page) when that ships.
import type { LaneId } from "@nichols/core";
import type { Connector } from "../contract/connector";
import type { LaneBoundConnection } from "../contract/lane-bound";

export type ConnectionCheckStatus = "ok" | "reconnect_required" | "not_connected" | "error";
export type ConnectionCheck = { status: ConnectionCheckStatus; checked_at: string; intuit_tid: string | null };

export type ConnectionCheckDeps = {
  /** The lane's QuickBooks connection that is not disconnected, or null. */
  find(laneId: LaneId): Promise<LaneBoundConnection | null>;
  connector: Pick<Connector<"quickbooks">, "health">;
  now?: () => number;
};

export function createConnectionCheck(deps: ConnectionCheckDeps): (laneId: LaneId) => Promise<ConnectionCheck> {
  const now = deps.now ?? Date.now;
  return async (laneId) => {
    const checked_at = () => new Date(now()).toISOString();
    let conn: LaneBoundConnection | null;
    try {
      conn = await deps.find(laneId);
    } catch {
      return { status: "error", checked_at: checked_at(), intuit_tid: null };
    }
    // Nothing connected yet, or a connection that never finished (no token stored).
    if (!conn || conn.provider !== "quickbooks" || conn.status === "pending") return { status: "not_connected", checked_at: checked_at(), intuit_tid: null };
    try {
      const h = await deps.connector.health(laneId, conn as LaneBoundConnection<"quickbooks">);
      const status: ConnectionCheckStatus = h.ok ? "ok" : h.status === "reconnect_required" ? "reconnect_required" : "error";
      return { status, checked_at: h.checked_at, intuit_tid: h.provider_tid ?? null };
    } catch {
      return { status: "error", checked_at: checked_at(), intuit_tid: null };
    }
  };
}
