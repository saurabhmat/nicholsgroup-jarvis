import { ConnectorError } from "./errors";
import type { ConnectionStatus, Freshness } from "./schemas";

const USABLE: ReadonlySet<ConnectionStatus> = new Set(["active", "degraded"]);

/** Whether jobs may sync or read through a connection in this status (no sync in `reconnect_required`, QB-4). */
export function isSyncAllowed(status: ConnectionStatus): boolean {
  return USABLE.has(status);
}

/**
 * Call with the status from the **authoritative** row (never the caller's object). Throws `reconnect_required`
 * (never retried) or `connection_unavailable`.
 */
export function assertStatusUsable(status: ConnectionStatus): void {
  if (status === "reconnect_required") {
    throw new ConnectorError({ kind: "reconnect_required", message: "Connection needs to be reconnected" });
  }
  if (!USABLE.has(status)) {
    throw new ConnectorError({ kind: "connection_unavailable", message: `Connection is ${status}` });
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
