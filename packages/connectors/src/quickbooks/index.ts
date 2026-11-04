// QuickBooks wiring (T-050): the connector, its OAuth provider and token manager over the real Vault, lane router
// (through the vault module), connector env and discovery cache. Server-only. Credentials are read from the connector
// env at call time (`requireConnectorEnv("intuit")` fails closed naming missing variables, never printing values).
import { requireConnectorEnv } from "@nichols/core/env/server";
import { connectionLoader, connectionStore, getToken, laneConfigReader, revokeToken, rotateToken, storeToken } from "../vault/index";
import { SecretValue } from "../vault/secret";
import { createQboApi } from "./api";
import { createQuickBooksConnector, type QboConnection } from "./connector";
import { createDiscovery } from "./discovery";
import { createQuickBooksOAuthProvider, type QboClientConfig } from "./provider";
import { createTokenManager } from "./token-manager";

const discovery = createDiscovery();

function environment() {
  return requireConnectorEnv("intuit").INTUIT_ENVIRONMENT;
}

function client(): QboClientConfig {
  const env = requireConnectorEnv("intuit");
  return { clientId: env.INTUIT_CLIENT_ID, clientSecret: new SecretValue(env.INTUIT_CLIENT_SECRET), redirectUri: env.INTUIT_REDIRECT_URI };
}

export const quickbooksOAuthProvider = createQuickBooksOAuthProvider({ environment, client, discovery, laneConfig: laneConfigReader });

const vault = { getToken, rotateToken, storeToken, revokeToken };

const tokens = createTokenManager({
  vault,
  tokenEndpoint: async (laneId) => (await discovery.get(laneId, environment())).token,
  client,
});

const api = createQboApi({ tokens, environment });

export const quickbooksConnector = createQuickBooksConnector({
  provider: quickbooksOAuthProvider,
  environment,
  client,
  discovery,
  laneConfig: laneConfigReader,
  vault,
  connections: {
    ensureConnection: connectionStore.ensureConnection,
    load: (laneId, id) => connectionLoader.loadConnection(laneId, id) as Promise<QboConnection>,
  },
  tokens,
  api,
});

export { QBO_SCOPE, QBO_SLUG } from "./constants";
