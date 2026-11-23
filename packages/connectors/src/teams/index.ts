import "server-only";
// Teams wiring (T-279): the guard, token manager, Graph read client and health check over the real Vault, lane router (through the vault module) and connector env.
// Server-only. Credentials are read from the connector env at call time (`requireConnectorEnv("graph_teams")` fails closed naming missing variables, never printing values) and
// are the TEAMS app's: a second Entra registration, so the mail app's secret is never used here and a Teams token cannot reach mail.
//
// NOT wired here, on purpose: the Graph write client and the message writer (built only in the approvals-only writer wiring file, exported through the write subpath for the approvals module; write-boundary.test.ts proves
// nothing else builds them). The shared guard, token manager and read client live in ./wiring.ts. The chat reader (T-281) is wired below: GET only, for the signed-in owner. The notice subscription
// (T-289, below) has its OWN client with an exact allow-list of the three subscription routes (create, renew, stop); it can reach no chat and no message, and only the renewal job calls it.
import { EnvValidationError, describeEnvError, getGraphNotificationUrl, requireConnectorEnv } from "@nichols/core/env/server";
import { ConnectorError } from "../contract/errors";
import type { SubscriptionRenewer } from "../health/types";
import { connectionLoader, laneConfigReader, microsoftSubscriptionStore, revokeToken, teamsActionsStore, teamsChatReadsStore, teamsIdentityReader, teamsIdentityWriter, teamsNoticesStore } from "../vault/index";
import { SecretValue } from "../vault/secret";
import { createTeamsDisconnect } from "./disconnect";
import { createTeamsHealth, createTeamsHealthSkip } from "./health";
import { createTeamsOAuthProvider, type TeamsClientConfig } from "./provider";
import { createTeamsChannelReader } from "./channels";
import { createTeamsImageReader } from "./images";
import { createTeamsReader } from "./reader";
import { createTeamsSubscriptionClient } from "./subscription-client";
import { createTeamsSubscriptions } from "./subscriptions";
import { errors, guard, teamsApi, tokens } from "./wiring";

function connectClient(): TeamsClientConfig {
  const env = requireConnectorEnv("graph_teams");
  return { clientId: env.GRAPH_TEAMS_CLIENT_ID, clientSecret: new SecretValue(env.GRAPH_TEAMS_CLIENT_SECRET), redirectUri: env.GRAPH_TEAMS_REDIRECT_URI };
}

/** The guarded, read-only Teams Graph client (GET only, exact path templates, a named actor on every call). Used by the health check now; the chat reader (T-281) next. */
export { teamsApi };
/** `GET /me`: registered with conn.token_health (health/index.ts). */
export const teamsHealth = createTeamsHealth({ api: teamsApi });
/** Tells the daily health job to skip a Teams connection whose lane has Teams switched off (registered in health/index.ts). */
export const teamsHealthSkip = createTeamsHealthSkip({ laneConfig: laneConfigReader });

/** The connect flow's Teams provider (T-279), registered in oauth/registry.ts. */
export const teamsOAuthProvider = createTeamsOAuthProvider({
  client: connectClient,
  laneConfig: laneConfigReader,
  identity: teamsIdentityReader,
  identityWriter: teamsIdentityWriter,
});

/** Local Disconnect (spec 5): deletes the Vault tokens, marks the row `disconnected`, marks its subscriptions removed. No request to Microsoft. */
export const disconnectTeams = createTeamsDisconnect({
  loader: connectionLoader,
  vault: { revokeToken },
  subscriptions: microsoftSubscriptionStore,
  // T-282: the portal's read markers go with the connection (the retention purge also removes those of any disconnected connection, should this one fail). T-286: the open Teams send actions
  // of the connection are closed with their text purged. T-289 adds the notice counters here.
  purgers: [
    { name: "chat_reads", purge: (laneId, connectionId) => teamsChatReadsStore.purgeConnection(laneId, connectionId) },
    { name: "send_actions", purge: (laneId, connectionId) => teamsActionsStore.purgeConnection(laneId, connectionId) },
    // T-289: the connection's notice times (comms.teams_activity); its subscription rows were marked removed above (their Vault secrets deleted).
    { name: "activity", purge: (laneId, connectionId) => teamsNoticesStore.purgeConnection(laneId, connectionId) },
  ],
});

/** The chat reader (T-281, T-284): read-only, over the guarded Teams client. Used through `@nichols/connectors/teams-reader` only (a narrow, server-only surface). */
export const teamsReader = createTeamsReader({ api: teamsApi });

/** The channel reader (T-291): joined teams, channels, root posts and replies, read only, over the same guarded client. */
export const teamsChannelReader = createTeamsChannelReader({ api: teamsApi });
/** The inline-image reader (T-285): the bytes of one hosted content, read only, over the same guarded client. */
export const teamsImageReader = createTeamsImageReader({ api: teamsApi });

/**
 * New-message notices (T-289, spec 9): create, renew and stop the ONE all-chats subscription of a Teams connection, through the Teams subscription client (an exact allow-list of three routes; lint
 * restricts who may name it). Called only by `teamsSubscriptionRenewer` below (the conn.subscriptions_renew job). The notification URL is server configuration only: `GRAPH_NOTIFICATION_URL`,
 * validated by the env schema (https, own origin, ending /api/webhooks/microsoft); unset = no subscription is attempted and the page offers Refresh.
 */
export const teamsSubscriptions = createTeamsSubscriptions({
  client: createTeamsSubscriptionClient({ guard, tokens, errors }),
  store: microsoftSubscriptionStore,
  notices: teamsNoticesStore,
  identity: teamsIdentityReader,
  laneConfig: laneConfigReader,
  notificationUrl: () => {
    try {
      return getGraphNotificationUrl();
    } catch (e) {
      // The text is the variable's NAME and a fixed rule (describeEnvError), never a value: safe for the log line `ensure` writes.
      throw new ConnectorError({ kind: "connection_unavailable", message: e instanceof EnvValidationError ? describeEnvError(e) : "The notification URL could not be read" });
    }
  },
});
/** Registered in the T-040 `conn.subscriptions_renew` registry (health/index.ts): ensures the connection's subscription (create when missing, renew within 24 hours of expiry, recreate when gone, stop when paused). */
export const teamsSubscriptionRenewer: SubscriptionRenewer = async (laneId, conn, input) => {
  const outcome = await teamsSubscriptions.ensure(laneId, conn, input);
  return { renewed: outcome.created + outcome.renewed > 0, expires_at: outcome.expiresAt ? outcome.expiresAt.toISOString() : null };
};
