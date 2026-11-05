// Google wiring (T-063): the OAuth provider, token manager, Gmail API client, mail provider and sync over the real
// Vault, lane router (through the vault module) and connector env. Server-only. Credentials are read from the connector
// env at call time (`requireConnectorEnv("google")` fails closed naming missing variables, never printing values).
import { requireConnectorEnv } from "@nichols/core/env/server";
import { connectionLoader, getToken, laneConfigReader, mailIndexStore, revokeToken, rotateToken, storeToken } from "../vault/index";
import { SecretValue } from "../vault/secret";
import { createGoogleApi } from "./api";
import { createGmailProvider } from "./mail";
import { createMailSync } from "./mail-sync";
import { createGoogleOAuthProvider, type GoogleClientConfig } from "./provider";
import { createGoogleTokenManager } from "./token-manager";
import { createGoogleWriter } from "./writer";

function client(): GoogleClientConfig {
  const env = requireConnectorEnv("google");
  return { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: new SecretValue(env.GOOGLE_OAUTH_CLIENT_SECRET), redirectUri: env.GOOGLE_REDIRECT_URI };
}

export const googleOAuthProvider = createGoogleOAuthProvider({ client, laneConfig: laneConfigReader });

const vault = { getToken, rotateToken, storeToken, revokeToken };
const tokens = createGoogleTokenManager({ vault, client });
const api = createGoogleApi({ tokens });
const connections = { load: (laneId: string, id: string) => connectionLoader.loadConnection(laneId, id) };

/** Gmail metadata sync, live body, live search. Polling until T-065 adds push. */
export const gmailProvider = createGmailProvider({ api, connections, laneConfig: laneConfigReader });
/** Runs one connection's mail metadata sync into comms.message_index (the sync job calls this; Inngest wiring: T-038/T-065). */
export const mailSync = createMailSync({ mail: gmailProvider, store: mailIndexStore });

/** Revoke-at-Google and delete-Vault-tokens (D-24: approvals only). No route, job or connector method calls it. */
export const googleWriter = createGoogleWriter({ vault, connections, tokens });

export { mailIndexStore };
export { GOOGLE_SLUG, GOOGLE_SCOPES } from "./constants";
