// QuickBooks wiring (T-050): the connector, its OAuth provider and token manager over the real Vault, lane router
// (through the vault module), connector env and discovery cache. Server-only. Credentials are read from the connector
// env at call time (`requireConnectorEnv("intuit")` fails closed naming missing variables, never printing values).
import { getServerEnv, requireConnectorEnv } from "@nichols/core/env/server";
import { getAudit } from "@nichols/core/lane-router";
import type { LaneBoundConnection } from "../contract/lane-bound";
import { connectionLoader, getToken, normalizeStore, reportCacheStore, qboFeatureStore, laneConfigReader, reconnectStore, revokeToken, rotateToken, storeToken } from "../vault/index";
import { SecretValue } from "../vault/secret";
import { createQboApi } from "./api";
import { createQuickBooksConnector } from "./connector";
import { createQboFeatureRecorder } from "./features";
import { createQboNormalizeJob } from "./normalize-job";
import { createQboReportsJob } from "./reports-job";
import { createQuickBooksDisconnectVerifier, createQuickBooksWriter } from "./writer";
import { createDiscovery } from "./discovery";
import { createQuickBooksOAuthProvider, type QboClientConfig } from "./provider";
import { createTokenManager } from "./token-manager";
import { createReconnectRecorder, createReconnectStore } from "./reconnect";
import { connAttentionNeeded, sendLaneEvent } from "@nichols/core/inngest";

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

/**
 * invalid_grant (and a 401 that survives a refresh): the connection is recorded as reconnect_required (so conn.sync, the webhook
 * CDC and the reports job skip it) and the admin is notified with the existing `conn/attention.needed` event (T-040), one per
 * connection per day. Best effort: jobs not configured (local dev without Inngest) only means no notification.
 */
const onReconnectRequired = createReconnectRecorder({
  store: reconnectStore,
  notify: async ({ laneId, connectionId, provider, errorKind }) => {
    const data: { laneId: string } = { laneId, connectionId, provider, reason: "reconnect_required", errorKind } as { laneId: string };
    await sendLaneEvent({
      name: connAttentionNeeded.name,
      data,
      id: `attn:${laneId}:${connectionId}:reconnect_required:${new Date().toISOString().slice(0, 10)}`,
    });
  },
});

const tokens = createTokenManager({
  vault,
  tokenEndpoint: async (laneId) => (await discovery.get(laneId, environment())).token,
  client,
  onReconnectRequired,
});

const api = createQboApi({ tokens, environment, onReconnectRequired });

const connections = { load: (laneId: string, id: string) => connectionLoader.loadConnection(laneId, id) };

/** The read-back after a disconnect (T-195): the connection is `disconnected` and the Vault hands out no token. Read-only. */
export const quickbooksDisconnectVerifier = createQuickBooksDisconnectVerifier({ connections, vault });

/** Edition flags from Preferences go to core.connections.features; a change is audited (T-051). */
const features = createQboFeatureRecorder({ store: qboFeatureStore, audit: getAudit() });

export const quickbooksConnector = createQuickBooksConnector({ connections, api, features, payroll: (laneId) => laneConfigReader.payrollSettings(laneId) });

/** The nightly report pull of one connection into fin.report_cache (T-052): GET only, over the same API client. */
export const quickbooksReportsJob = createQboReportsJob({
  loader: connectionLoader,
  api,
  store: reportCacheStore,
  settings: (laneId) => laneConfigReader.reportSettings(laneId),
  payroll: (laneId) => laneConfigReader.payrollSettings(laneId),
});

/** raw.source_records -> fin.* for one connection, after a successful sync (T-056): one SQL function, no provider call. */
export const quickbooksNormalizeJob = createQboNormalizeJob({ loader: connectionLoader, store: normalizeStore });

/**
 * Revoke-at-Intuit and delete-Vault-tokens (D-24: approvals only). Reached through `@nichols/connectors/writer`-side
 * code in the approvals module; no route, job or connector method calls it.
 */
export const quickbooksWriter = createQuickBooksWriter({ provider: quickbooksOAuthProvider, environment, client, discovery, vault, connections, tokens });

/** The authoritative, lane-bound QuickBooks connection row the disconnect executor runs on (write subpath only). */
export async function loadQuickbooksWriteConnection(laneId: string, connectionId: string) {
  return (await connectionLoader.loadConnection(laneId, connectionId)) as LaneBoundConnection<"quickbooks">;
}

export { QBO_SCOPE, QBO_SLUG } from "./constants";
