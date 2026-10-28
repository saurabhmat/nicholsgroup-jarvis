import type { LaneId } from "@nichols/core";
import { ConnectorError } from "./errors";
import type { Connection, ConnectionStatus, Freshness } from "./schemas";

const USABLE: ReadonlySet<ConnectionStatus> = new Set(["active", "degraded"]);

/** Whether jobs may sync or read through a connection in this status (no sync in `reconnect_required`, QB-4). */
export function isSyncAllowed(status: ConnectionStatus): boolean {
  return USABLE.has(status);
}

/**
 * Every connector method calls this first: the connection must belong to the caller's lane and be usable.
 * Throws a `ConnectorError` (`invalid_input`, `lane_mismatch`, `reconnect_required` or `connection_unavailable`).
 */
export function assertConnectionUsable(laneId: LaneId, conn: Pick<Connection, "lane_id" | "status">): void {
  assertConnectionInLane(laneId, conn);
  if (conn.status === "reconnect_required") {
    throw new ConnectorError({ kind: "reconnect_required", message: "Connection needs to be reconnected" });
  }
  if (!USABLE.has(conn.status)) {
    throw new ConnectorError({ kind: "connection_unavailable", message: `Connection is ${conn.status}` });
  }
}

/** Lane check only (for `health` and `disconnect`, which must also work on unusable connections). */
export function assertConnectionInLane(laneId: LaneId, conn: Pick<Connection, "lane_id">): void {
  if (typeof laneId !== "string" || laneId.length === 0) {
    throw new ConnectorError({ kind: "invalid_input", message: "laneId is required" });
  }
  if (conn.lane_id !== laneId) {
    throw new ConnectorError({ kind: "lane_mismatch", message: "Connection does not belong to this lane" });
  }
}

/**
 * Freshness label for a source result. Thresholds come from lane_config; the caller passes them in.
 * Anything older than `staleAfterSeconds` (or with an unparseable `as_of`) is `stale`, live or cached.
 */
export function freshnessOf(input: { asOf: string; servedFromCache: boolean; now: Date; staleAfterSeconds: number }): Freshness {
  const asOf = Date.parse(input.asOf);
  if (Number.isNaN(asOf)) return "stale";
  const ageSeconds = (input.now.getTime() - asOf) / 1000;
  if (ageSeconds > input.staleAfterSeconds) return "stale";
  return input.servedFromCache ? "cached" : "live";
}
