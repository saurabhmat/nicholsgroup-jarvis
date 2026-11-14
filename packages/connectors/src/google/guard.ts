// The Google connectors only ever work on Google connections (same reasoning as QuickBooks T-050 H1): lane binding
// proves a connection belongs to the lane, not to this provider. Without this a Microsoft or QuickBooks connection of
// the lane could have its token sent to Google. `forbidden` (not lane_mismatch): the contract suite's rule.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { assertStatusUsable } from "../contract/guards";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import type { LaneConfigReader } from "../vault/lane-config";
import { assertMailAccountAllowed, readMailPolicy } from "../vault/mail-policy";

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
  /** The mail policy (`mail.allowed_domains`, optional `mailboxes`) is re-read on every call that reaches Google (an account removed from the lane stops working at once). */
  laneConfig: Pick<LaneConfigReader, "mailboxes" | "mailDomains">;
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
      // Fail closed (T-247): an account whose domain is not allowed for the lane (or an empty domain list), or that is no longer on the
      // lane's exact mailbox list when it keeps one, is not read. This is in addition to D-23 and to the connect-time check.
      assertMailAccountAllowed(await readMailPolicy(deps.laneConfig, laneId), row.external_account_id);
    }
    return row;
  };
}
