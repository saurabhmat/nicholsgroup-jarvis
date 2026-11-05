// The Google connectors only ever work on Google connections (same reasoning as QuickBooks T-050 H1): lane binding
// proves a connection belongs to the lane, not to this provider. Without this a Microsoft or QuickBooks connection of
// the lane could have its token sent to Google. `forbidden` (not lane_mismatch): the contract suite's rule.
import { ConnectorError } from "../contract/errors";
import type { LaneBoundConnection } from "../contract/lane-bound";

export type GoogleConnection = LaneBoundConnection<"google">;

export function assertGoogleConnection(conn: { readonly provider: string }): asserts conn is GoogleConnection {
  if (conn.provider !== "google") {
    throw new ConnectorError({ kind: "forbidden", message: "Connection belongs to another provider" });
  }
}

/** Refuses a base URL whose host is not one of the allowed Google hosts. */
export function assertGoogleHost(baseUrl: string, allowed: ReadonlySet<string>): void {
  const ok = URL.canParse(baseUrl) && allowed.has(new URL(baseUrl).hostname);
  // Loopback is allowed for local mocks only through an injected httpFor; never from production wiring.
  if (!ok) throw new ConnectorError({ kind: "invalid_input", message: "Host is not an allowed Google host" });
}
