// Local Disconnect of a Teams account (T-279, spec 5 "Disconnect"; the pattern of microsoft/disconnect.ts, D-55). Microsoft has no token revocation endpoint a delegated token can call,
// so Disconnect is LOCAL: the stored tokens are deleted from the Vault and the row becomes `disconnected`, both in one database call (`core.connection_token_revoke`, which also writes the audit
// row `connection.disconnected` with the user as actor). NOTHING is sent to Microsoft: this module imports no HTTP client, no token manager and no guard, reads no token and makes no
// request (so it is not an external write, rule 5, and does not go through approvals).
//   - the row is loaded by (lane, id): another lane's id is `not_found`;
//   - it must be a Teams row owned by the user asking: otherwise `not_found` (the same answer, so another person's row is not revealed; a mailbox row is never disconnected here);
//   - it does NOT matter whether Teams is currently enabled for the lane: a paused connection can be disconnected too (no config read);
//   - the connection's change-notification subscriptions are marked removed in our own records (best effort, never blocks the disconnect);
//   - `purgers` delete the Teams data the portal holds for the connection (the portal's read markers, T-282; the notice counters, T-289) and invalidate its open `teams.*` actions
//     with their text purged (T-286). None exists yet in this build, so the list is empty here; each later task adds its purger to the wiring. A purger that fails is logged by class only
//     and never blocks the disconnect (the tokens are already gone).
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { ConnectionLoader } from "../contract/lane-bound";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { TokenVault } from "../vault/tokens";
import { TEAMS_PROVIDER } from "./constants";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TeamsPurger = { name: string; purge(laneId: LaneId, connectionId: string): Promise<unknown> };

export type TeamsDisconnectDeps = {
  loader: Pick<ConnectionLoader<string>, "loadConnection">;
  vault: Pick<TokenVault, "revokeToken">;
  /** Marks the connection's change-notification subscriptions removed. Optional: without it nothing is recorded. */
  subscriptions?: { removeConnection(laneId: LaneId, connectionId: string): Promise<unknown> };
  purgers?: readonly TeamsPurger[];
  logger?: ConnectorLogger;
};

export function createTeamsDisconnect(deps: TeamsDisconnectDeps) {
  /** Resolves true when a stored credential was deleted (false: none was stored, the row is now `disconnected` all the same). */
  return async function disconnect(laneId: LaneId, connectionId: string, actorUserId: string): Promise<boolean> {
    if (typeof actorUserId !== "string" || !UUID.test(actorUserId)) throw new ConnectorError({ kind: "invalid_input", message: "A signed-in user is required" });
    const conn = await deps.loader.loadConnection(laneId, connectionId);
    if (conn.provider !== TEAMS_PROVIDER || conn.owner_user_id !== actorUserId) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
    const deleted = await deps.vault.revokeToken(laneId, conn, actorUserId);
    const log = deps.logger ?? connectorLog;
    try {
      await deps.subscriptions?.removeConnection(laneId, conn.id);
    } catch {
      log.warn("teams.disconnect.subscriptions_unconfirmed", { laneId, connectionId: conn.id, provider: TEAMS_PROVIDER });
    }
    for (const purger of deps.purgers ?? []) {
      try {
        await purger.purge(laneId, conn.id);
      } catch {
        // Ids and an enum only: the message could name a lane or a row.
        log.warn("teams.disconnect.purge_unconfirmed", { laneId, connectionId: conn.id, provider: TEAMS_PROVIDER, purger: purger.name });
      }
    }
    return deleted;
  };
}
