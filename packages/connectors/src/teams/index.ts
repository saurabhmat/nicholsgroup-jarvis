import "server-only";
// Teams wiring (T-279): the guard, token manager, Graph read client and health check over the real Vault, lane router (through the vault module) and connector env.
// Server-only. Credentials are read from the connector env at call time (`requireConnectorEnv("graph_teams")` fails closed naming missing variables, never printing values) and
// are the TEAMS app's: a second Entra registration, so the mail app's secret is never used here and a Teams token cannot reach mail.
//
// NOT wired here, on purpose (later tasks): the Graph write client (built only by the approvals wiring in T-286; write-boundary.test.ts proves nothing else builds it) and the
// subscription renewer (T-289). The chat reader (T-281) is wired below: GET only, for the signed-in owner.
import { requireConnectorEnv } from "@nichols/core/env/server";
import { attentionEventId, connAttentionNeeded, sendLaneEvent } from "@nichols/core/inngest";
import { createApiErrorSink } from "../error-log/sink";
import { classifyGraphFailure } from "../microsoft/errors";
import { createReconnectRecorder } from "../quickbooks/reconnect";
import { apiErrorStore, connectionLoader, getToken, laneConfigReader, microsoftSubscriptionStore, reconnectStore, revokeToken, rotateToken, teamsChatReadsStore, teamsIdentityReader, teamsIdentityWriter } from "../vault/index";
import { SecretValue } from "../vault/secret";
import { createTeamsApi } from "./api";
import { createTeamsDisconnect } from "./disconnect";
import { createTeamsGuard } from "./guard";
import { createTeamsHealth, createTeamsHealthSkip } from "./health";
import { createTeamsOAuthProvider, type TeamsClientConfig } from "./provider";
import { createTeamsReader } from "./reader";
import { createTeamsTokenManager } from "./token-manager";

function client() {
  const env = requireConnectorEnv("graph_teams");
  return { clientId: env.GRAPH_TEAMS_CLIENT_ID, clientSecret: new SecretValue(env.GRAPH_TEAMS_CLIENT_SECRET) };
}

function connectClient(): TeamsClientConfig {
  const env = requireConnectorEnv("graph_teams");
  return { clientId: env.GRAPH_TEAMS_CLIENT_ID, clientSecret: new SecretValue(env.GRAPH_TEAMS_CLIENT_SECRET), redirectUri: env.GRAPH_TEAMS_REDIRECT_URI };
}

const guard = createTeamsGuard({
  connections: { load: (laneId, id) => connectionLoader.loadConnection(laneId, id) },
  laneConfig: laneConfigReader,
  identity: teamsIdentityReader,
});

/** A refresh token Microsoft refused: the connection is recorded as reconnect_required and the admin is notified (T-195 recorder, same as mail and QuickBooks). */
const onReconnectRequired = createReconnectRecorder({
  store: reconnectStore,
  notify: async ({ laneId, connectionId, provider, errorKind }) => {
    await sendLaneEvent(connAttentionNeeded.create({ laneId, connectionId, provider, reason: "reconnect_required", errorKind }, { id: attentionEventId(laneId, connectionId, "reconnect_required", new Date()) }));
  },
});

const tokens = createTeamsTokenManager({ vault: { getToken, rotateToken }, client, onReconnectRequired });
const errors = createApiErrorSink({ store: apiErrorStore, messageFor: (info) => classifyGraphFailure(info).message });

/** The guarded, read-only Teams Graph client (GET only, exact path templates, a named actor on every call). Used by the health check now; the chat reader (T-281) next. */
export const teamsApi = createTeamsApi({ guard, tokens, errors });
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
  // T-282: the portal's read markers go with the connection (the retention purge also removes those of any disconnected connection, should this one fail). T-286 and T-289 add theirs here.
  purgers: [{ name: "chat_reads", purge: (laneId, connectionId) => teamsChatReadsStore.purgeConnection(laneId, connectionId) }],
});

/** The chat reader (T-281, T-284): read-only, over the guarded Teams client. Used through `@nichols/connectors/teams-reader` only (a narrow, server-only surface). */
export const teamsReader = createTeamsReader({ api: teamsApi });
