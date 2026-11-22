// Local Disconnect of a Microsoft mailbox (T-257, D-55; docs/plan-review.md "T-257: spec §15 verify items", V-9).
//
// Microsoft has no token revocation endpoint our delegated token can call (V-9), so Disconnect is LOCAL: the stored tokens are deleted from the
// Vault and the row becomes `disconnected`, both in one database call (`core.connection_token_revoke`, which also writes the audit row
// `connection.disconnected` with the user as actor). NOTHING is sent to Microsoft: this module imports no HTTP client, no token manager and no
// guard, reads no token and makes no request. That is why it is not an external write (CLAUDE.md rule 5) and does not go through approvals.
//
// Rules, all checked here and not only by the caller:
//   - the row is loaded by (lane, id) from the authoritative store: another lane's id is `not_found`;
//   - it must be a Microsoft row and owned by the user asking: otherwise `not_found` (the same answer, so a row of another person is not
//     revealed to someone who cannot see it);
//   - it does NOT matter whether Microsoft is currently enabled for the lane: a paused connection can be disconnected too (no config read).
//   - T-264: the connection's change-notification subscriptions are marked removed in our own records afterwards (`subscriptions.removeConnection`, a database call, still
//     nothing sent to Microsoft: the token is gone and a request in a user request is not allowed). It is best effort and never blocks or fails the disconnect. Microsoft's side of
//     the subscription lapses at its expiry (at most 6 days); until then the receiver drops everything that arrives for it, because no live row exists. A lookup also refuses a
//     disconnected connection, so a failed mark changes nothing for the receiver.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { ConnectionLoader } from "../contract/lane-bound";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { TokenVault } from "../vault/tokens";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MicrosoftDisconnectDeps = {
  loader: Pick<ConnectionLoader<string>, "loadConnection">;
  vault: Pick<TokenVault, "revokeToken">;
  /** Marks the connection's change-notification subscriptions removed (T-264). Optional: without it nothing is recorded. */
  subscriptions?: { removeConnection(laneId: LaneId, connectionId: string): Promise<unknown> };
  logger?: ConnectorLogger;
};

export function createMicrosoftDisconnect(deps: MicrosoftDisconnectDeps) {
  /** Resolves true when a stored credential was deleted (false: none was stored, the row is now `disconnected` all the same). */
  return async function disconnect(laneId: LaneId, connectionId: string, actorUserId: string): Promise<boolean> {
    if (typeof actorUserId !== "string" || !UUID.test(actorUserId)) throw new ConnectorError({ kind: "invalid_input", message: "A signed-in user is required" });
    const conn = await deps.loader.loadConnection(laneId, connectionId);
    if (conn.provider !== "microsoft" || conn.owner_user_id !== actorUserId) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
    const deleted = await deps.vault.revokeToken(laneId, conn, actorUserId);
    try {
      await deps.subscriptions?.removeConnection(laneId, conn.id);
    } catch {
      // Best effort (the message could name a lane or a row: ids and an enum only).
      (deps.logger ?? connectorLog).warn("microsoft.disconnect.subscriptions_unconfirmed", { laneId, connectionId: conn.id, provider: "microsoft" });
    }
    return deleted;
  };
}
