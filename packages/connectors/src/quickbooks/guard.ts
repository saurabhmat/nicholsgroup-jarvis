// The QuickBooks connector only ever works on QuickBooks connections (T-050 security H1). Lane binding proves a
// connection belongs to the lane, not to this provider: without this check a Google or Stripe connection of the same
// lane could have its tokens sent to Intuit (as a Bearer token or a refresh grant) and then be revoked and deleted.
// Checked in the connector (before and after the authoritative reload), the token manager and the API client, so each
// is safe on its own.
import { ConnectorError } from "../contract/errors";
import type { LaneBoundConnection } from "../contract/lane-bound";

export type QboConnection = LaneBoundConnection<"quickbooks">;

export function assertQuickbooksConnection(conn: { readonly provider: string }): asserts conn is QboConnection {
  if (conn.provider !== "quickbooks") {
    throw new ConnectorError({ kind: "lane_mismatch", message: "Connection belongs to another provider" });
  }
}
