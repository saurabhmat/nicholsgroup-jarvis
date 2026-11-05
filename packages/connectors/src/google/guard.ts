// The Google connectors only ever work on Google connections (same reasoning as QuickBooks T-050 H1): lane binding
// proves a connection belongs to the lane, not to this provider. Without this a Microsoft or QuickBooks connection of
// the lane could have its token sent to Google. `forbidden` (not lane_mismatch): the contract suite's rule.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { assertStatusUsable } from "../contract/guards";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import type { LaneConfigReader } from "../vault/lane-config";

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

export type ProviderGuardDeps = {
  /** The authoritative connection row (status, lane, provider), read on every call. */
  connections: { load(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<string>> };
  /** `mailboxes` is re-read on every call that reaches Google (a mailbox removed from the lane stops working at once). */
  laneConfig: Pick<LaneConfigReader, "mailboxes">;
};

/**
 * The guard every Gmail and Calendar provider call runs first (T-063, T-064): lane brand, provider, authoritative row
 * (status, lane, provider) and, for calls that reach Google, the lane's current mailbox list - all before any token read
 * or request. Returns the AUTHORITATIVE row: use it, not the caller's object.
 */
export function createProviderGuard(deps: ProviderGuardDeps) {
  return async function guard(laneId: LaneId, conn: unknown, opts: { mailbox?: boolean } = {}): Promise<GoogleConnection> {
    assertLaneBound(laneId, conn);
    assertGoogleConnection(conn);
    const row = await deps.connections.load(laneId, conn.id);
    assertGoogleConnection(row);
    if (row.id !== conn.id) throw new ConnectorError({ kind: "lane_mismatch", message: "Connection row does not match" });
    assertStatusUsable(row.status);
    if (opts.mailbox) {
      // Fail closed: a mailbox no longer on the lane's list (or an empty list) is not read.
      const allowed = await deps.laneConfig.mailboxes(laneId);
      if (!allowed.includes(row.external_account_id.toLowerCase())) {
        throw new ConnectorError({ kind: "forbidden", message: "This mailbox is not one of the lane's configured mailboxes" });
      }
    }
    return row;
  };
}
