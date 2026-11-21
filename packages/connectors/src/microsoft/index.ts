import "server-only";
// Microsoft wiring (T-256): the guard, token manager, Graph client and health check over the real Vault, lane router (through the vault
// module) and connector env. Server-only. Credentials are read from the connector env at call time (`requireConnectorEnv("graph")`
// fails closed naming missing variables, never printing values). Nothing here connects an account (T-066) or syncs (T-258, T-067).
import { requireConnectorEnv } from "@nichols/core/env/server";
import { attentionEventId, connAttentionNeeded, sendLaneEvent } from "@nichols/core/inngest";
import { createApiErrorSink } from "../error-log/sink";
import { createReconnectRecorder } from "../quickbooks/reconnect";
import { apiErrorStore, connectionLoader, getToken, laneConfigReader, microsoftIdentityReader, microsoftIdentityWriter, reconnectStore, revokeToken, rotateToken, writePolicyReader } from "../vault/index";
import { SecretValue } from "../vault/secret";
import { createGraphApi } from "./api";
import { createMicrosoftConnectInfo } from "./consent";
import { createMicrosoftDisconnect } from "./disconnect";
import { classifyGraphFailure } from "./errors";
import { createMicrosoftGuard } from "./guard";
import { createMicrosoftHealth, createMicrosoftHealthSkip } from "./health";
import { createMicrosoftOAuthProvider, type MicrosoftClientConfig } from "./provider";
import { createMicrosoftTokenManager } from "./token-manager";

function client() {
  const env = requireConnectorEnv("graph");
  return { clientId: env.GRAPH_CLIENT_ID, clientSecret: new SecretValue(env.GRAPH_CLIENT_SECRET) };
}

function connectClient(): MicrosoftClientConfig {
  const env = requireConnectorEnv("graph");
  return { clientId: env.GRAPH_CLIENT_ID, clientSecret: new SecretValue(env.GRAPH_CLIENT_SECRET), redirectUri: env.GRAPH_REDIRECT_URI };
}

const guard = createMicrosoftGuard({
  connections: { load: (laneId, id) => connectionLoader.loadConnection(laneId, id) },
  laneConfig: laneConfigReader,
  identity: microsoftIdentityReader,
});

/** A refresh token Microsoft refused: the connection is recorded as reconnect_required and the admin is notified (T-195 recorder, same as QuickBooks). */
const onReconnectRequired = createReconnectRecorder({
  store: reconnectStore,
  notify: async ({ laneId, connectionId, provider, errorKind }) => {
    await sendLaneEvent(connAttentionNeeded.create({ laneId, connectionId, provider, reason: "reconnect_required", errorKind }, { id: attentionEventId(laneId, connectionId, "reconnect_required", new Date()) }));
  },
});

const tokens = createMicrosoftTokenManager({ vault: { getToken, rotateToken }, client, onReconnectRequired });
const errors = createApiErrorSink({ store: apiErrorStore, messageFor: (info) => classifyGraphFailure(info).message });

/** The guarded, read-only Graph client. The facade's Microsoft entry does not use it yet (T-258, T-259, T-067). */
export const graphApi = createGraphApi({ guard, tokens, errors });
/** `GET /me`: registered with conn.token_health (health/index.ts). */
export const microsoftHealth = createMicrosoftHealth({ api: graphApi });
/** Tells the daily health job to skip a connection whose provider is switched off for the lane (registered in health/index.ts). */
export const microsoftHealthSkip = createMicrosoftHealthSkip({ laneConfig: laneConfigReader });

/** The connect flow's Microsoft provider (T-066), registered in oauth/registry.ts. Same email-write switch as Google's compose scope (T-232). */
export const microsoftOAuthProvider = createMicrosoftOAuthProvider({
  client: connectClient,
  laneConfig: laneConfigReader,
  identity: microsoftIdentityReader,
  identityWriter: microsoftIdentityWriter,
  writesAllowed: (laneId) => writePolicyReader.emailWritesAllowed(laneId),
});

/** The admin consent link of a lane (T-257: public values only, client id and redirect URI, the lane's connect scopes; none when it cannot be built) and whether the connect asks for write scopes (same scope list). Not a connect, stores nothing. */
export const microsoftConnectInfo = createMicrosoftConnectInfo({
  client: () => {
    const env = requireConnectorEnv("graph");
    return { clientId: env.GRAPH_CLIENT_ID, redirectUri: env.GRAPH_REDIRECT_URI };
  },
  scopesFor: (laneId) => microsoftOAuthProvider.scopesFor?.(laneId) ?? Promise.resolve(microsoftOAuthProvider.scopes),
});

/** Local Disconnect (T-257, D-55): deletes the Vault tokens and marks the row `disconnected`. No request to Microsoft. */
export const disconnectMicrosoft = createMicrosoftDisconnect({ loader: connectionLoader, vault: { revokeToken } });
