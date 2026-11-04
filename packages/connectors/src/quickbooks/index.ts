// QuickBooks wiring (T-050): the connector, its OAuth provider and token manager over the real Vault, lane router
// (through the vault module), connector env and discovery cache. Server-only. Credentials are read from the connector
// env at call time (`requireConnectorEnv("intuit")` fails closed naming missing variables, never printing values).
import { getServerEnv, requireConnectorEnv } from "@nichols/core/env/server";
import { connectionLoader, getToken, laneConfigReader, revokeToken, rotateToken, storeToken } from "../vault/index";
import { SecretValue } from "../vault/secret";
import { createQboApi } from "./api";
import { createQuickBooksConnector } from "./connector";
import { createQuickBooksWriter } from "./writer";
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

export const quickbooksOAuthProvider = createQuickBooksOAuthProvider({
  environment,
  client,
  discovery,
  laneConfig: laneConfigReader,
  // Production fails closed: a lane with no configured realm cannot connect (T-050 security L1).
  requireConfiguredRealm: () => getServerEnv().APP_ENV === "production",
});

const vault = { getToken, rotateToken, storeToken, revokeToken };

const tokens = createTokenManager({
  vault,
  tokenEndpoint: async (laneId) => (await discovery.get(laneId, environment())).token,
  client,
});

const api = createQboApi({ tokens, environment });

const connections = { load: (laneId: string, id: string) => connectionLoader.loadConnection(laneId, id) };

export const quickbooksConnector = createQuickBooksConnector({ connections, api });

/**
 * Revoke-at-Intuit and delete-Vault-tokens (D-24: approvals only). Reached through `@nichols/connectors/writer`-side
 * code in the approvals module; no route, job or connector method calls it.
 */
export const quickbooksWriter = createQuickBooksWriter({ provider: quickbooksOAuthProvider, environment, client, discovery, vault, connections, tokens });

export { QBO_SCOPE, QBO_SLUG } from "./constants";
