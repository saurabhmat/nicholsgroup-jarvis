// A fully wired QuickBooks connector over in-memory twins (T-050 tests only): the real connector, OAuth provider,
// token manager, API client and discovery, with the database-backed pieces (Vault, connection rows, lane config,
// connect state) replaced by faithful in-memory versions, and Intuit replaced by the MSW fake in ./msw/quickbooks.
// The Vault twin keeps the SQL's rules: lane-checked, disconnected cannot be read or rotated, and rotate is a
// compare-and-swap on the exact stored text (core.connection_token_rotate, 40001).
import { randomUUID } from "node:crypto";
import type { Audit, AuditEntry } from "@nichols/core/audit";
import { QBO_PAYROLL_SUBTYPES } from "@nichols/core/lane-config";
import { ACCOUNT_IN_USE_MESSAGE, ConnectorError } from "../contract/errors";
import { assertLaneBound, mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import type { Connection } from "../contract/schemas";
import { createHttpClient } from "../http/client";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { createOAuthFlow } from "../oauth/flow";
import { hashState } from "../oauth/pkce";
import type { StateStore } from "../oauth/state";
import { createQboApi } from "../quickbooks/api";
import { createQboFeatureRecorder, type QboFeatureStore } from "../quickbooks/features";
import { createQuickBooksConnector } from "../quickbooks/connector";
import { createQboReportsJob, type ReportCacheEntry, type ReportCacheStore } from "../quickbooks/reports-job";
import type { ReportSettings } from "../quickbooks/reports";
import type { QboConnection } from "../quickbooks/guard";
import { createQuickBooksRevoker, QBO_REVOKE_ACTION } from "../quickbooks/writer";
import { computePayloadSha256 } from "../contract/writer";
import { createDiscovery } from "../quickbooks/discovery";
import { createQuickBooksOAuthProvider } from "../quickbooks/provider";
import { createTokenManager } from "../quickbooks/token-manager";
import { SecretValue } from "../vault/secret";
import type { TokenVault } from "../vault/tokens";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_REALM, type FakeIntuit } from "./msw/quickbooks/handlers";

export const HARNESS_REDIRECT = "http://localhost:3000/api/connect/qbo/callback";

export type QboHarnessOptions = {
  intuit: FakeIntuit;
  environment?: "sandbox" | "production";
  /** Configured realm per lane (`lane_config.qbo.realm_id`); missing or null: none set. */
  realms?: Record<string, string | null>;
  /** Production mode: a lane with no configured realm refuses to connect. */
  requireConfiguredRealm?: boolean;
  startTime?: number;
};

type Row = { -readonly [K in keyof Connection<"quickbooks">]: Connection<"quickbooks">[K] };

export function createQboHarness(options: QboHarnessOptions) {
  const environment = options.environment ?? "sandbox";
  // Starts at the real time: the connect flow stamps `obtained_at` with the real clock.
  const clock = { t: options.startTime ?? Date.now() };
  const now = () => clock.t;
  const logs: LogEntry[] = [];
  const logger = createConnectorLogger({ sink: (e) => logs.push(e), now: () => new Date(clock.t) });
  const audits: AuditEntry[] = [];
  const audit: Audit = {
    async log(entry) {
      audits.push(entry);
    },
  };

  /** `lane_config.finance.payroll` twin: defaults are the schema's (Intuit payroll subtypes, no ids). Tests change it. */
  const payrollState: { settings: { accountIds: string[]; accountSubtypes: string[]; excludedEntityIds: string[] }; fail: boolean } = {
    settings: { accountIds: [], accountSubtypes: [...QBO_PAYROLL_SUBTYPES], excludedEntityIds: [] },
    fail: false,
  };

  const rows = new Map<string, Row>();
  const secrets = new Map<string, string>();
  const realms: Record<string, string | null> = { ...options.realms };
  const stats = { featureSaves: 0, rotations: 0, lostRaces: 0, stores: 0, revokes: 0, revokeActors: [] as (string | undefined)[] };
  const bind = (row: Row): QboConnection => mintLaneBoundConnection<"quickbooks">({ ...row, features: { ...row.features } });

  const rowOf = (laneId: string, conn: { id: string }): Row => {
    const row = rows.get(conn.id);
    if (!row || row.lane_id !== laneId) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
    return row;
  };

  const vault: Pick<TokenVault, "getToken" | "storeToken" | "rotateToken" | "revokeToken"> = {
    async getToken(laneId, conn) {
      assertLaneBound(laneId, conn);
      const row = rowOf(laneId, conn);
      if (row.status === "disconnected") throw new ConnectorError({ kind: "connection_unavailable", message: "The connection is disconnected" });
      const text = secrets.get(row.id);
      if (text === undefined) throw new ConnectorError({ kind: "not_found", message: "No stored credential for this connection" });
      return new SecretValue(text);
    },
    async storeToken(laneId, conn, secret, expiresAt) {
      assertLaneBound(laneId, conn);
      const row = rowOf(laneId, conn);
      // Twin of the unique index connections_one_lane_per_account (D-23) and of core.connection_token_store: a
      // connection becomes usable (active) only if no other usable connection holds the account (case-insensitive).
      // Disconnected and pending rows hold nothing. Nothing is stored when it is refused.
      const holder = [...rows.values()].find(
        (r) => r.id !== row.id && r.provider === row.provider && r.external_account_id.toLowerCase() === row.external_account_id.toLowerCase() && r.status !== "disconnected" && r.status !== "pending",
      );
      if (holder) throw new ConnectorError({ kind: "forbidden", message: ACCOUNT_IN_USE_MESSAGE });
      secrets.set(row.id, secret.reveal());
      row.status = "active";
      row.token_expires_at = expiresAt ? expiresAt.toISOString() : null;
      stats.stores += 1;
    },
    async rotateToken(laneId, conn, secret, expiresAt, replaces) {
      assertLaneBound(laneId, conn);
      const row = rowOf(laneId, conn);
      if (row.status === "disconnected") throw new ConnectorError({ kind: "connection_unavailable", message: "The connection is disconnected" });
      // One synchronous step: compare, then write (the SQL does this under the connection's row lock).
      if (secrets.get(row.id) !== replaces.reveal()) {
        stats.lostRaces += 1;
        return false;
      }
      secrets.set(row.id, secret.reveal());
      row.token_expires_at = expiresAt ? expiresAt.toISOString() : null;
      stats.rotations += 1;
      return true;
    },
    async revokeToken(laneId, conn, actorUserId) {
      assertLaneBound(laneId, conn);
      stats.revokeActors.push(actorUserId);
      const row = rowOf(laneId, conn);
      const had = secrets.delete(row.id);
      row.status = "disconnected";
      row.token_expires_at = null;
      stats.revokes += 1;
      return had;
    },
  };

  const connections = {
    async ensureConnection(laneId: string, provider: string, externalAccountId: string) {
      let row = [...rows.values()].find((r) => r.lane_id === laneId && r.provider === provider && r.external_account_id === externalAccountId);
      if (!row) {
        // A new row is `pending`, which holds no account (see storeToken: the refusal comes when it becomes active).
        row = {
          id: randomUUID(),
          lane_id: laneId,
          provider: provider as "quickbooks",
          external_account_id: externalAccountId,
          status: "pending",
          features: {},
          features_checked_at: null,
          token_expires_at: null,
          last_sync_at: null,
          last_error: null,
        };
        rows.set(row.id, row);
      }
      return bind(row) as LaneBoundConnection;
    },
    async load(laneId: string, id: string) {
      const row = rows.get(id);
      if (!row || row.lane_id !== laneId) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
      return bind(row);
    },
  };

  const laneConfig = {
    async qboRealmId(laneId: string) {
      return realms[laneId] ?? null;
    },
  };

  const fastHttp = (laneId: string, connectionId: string | undefined, baseUrl: string) =>
    createHttpClient({
      provider: "quickbooks",
      baseUrl,
      laneId,
      ...(connectionId ? { connectionId } : {}),
      requestIdHeader: "intuit_tid",
      errorCode: (b) => (b as { error?: unknown } | null)?.error as string | undefined,
      retryBaseMs: 1,
      retryMaxMs: 5,
      logger,
    });

  const client = () => ({ clientId: FAKE_CLIENT_ID, clientSecret: new SecretValue(FAKE_CLIENT_SECRET), redirectUri: HARNESS_REDIRECT });
  const discovery = createDiscovery({ now, logger });
  const provider = createQuickBooksOAuthProvider({
    environment: () => environment,
    client,
    discovery,
    laneConfig,
    requireConfiguredRealm: () => options.requireConfiguredRealm ?? false,
    now,
    logger,
    httpFor: (laneId, baseUrl) => fastHttp(laneId, undefined, baseUrl),
  });

  /** A token manager of its own (a second serverless instance sharing the same Vault). */
  const newTokenManager = () =>
    createTokenManager({
      vault,
      tokenEndpoint: async (laneId) => (await discovery.get(laneId, environment)).token,
      client,
      httpFor: fastHttp,
      now,
      logger,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    });
  const tokens = newTokenManager();
  const api = createQboApi({ tokens, environment: () => environment, logger, httpOptions: { retryBaseMs: 1, retryMaxMs: 5 } });
  // Twin of the real feature store: merges the flags into the row (service-role update of core.connections).
  const featureStore: QboFeatureStore = {
    async save(laneId, conn, features, checkedAt) {
      assertLaneBound(laneId, conn);
      const row = rowOf(laneId, conn);
      row.features = { ...row.features, ...features };
      row.features_checked_at = checkedAt;
      stats.featureSaves += 1;
    },
  };
  const features = createQboFeatureRecorder({ store: featureStore, audit });
  const connector = createQuickBooksConnector({ connections, api, features, now, logger, payroll: async () => {
    if (payrollState.fail) throw new ConnectorError({ kind: "transient", message: "Lane configuration unavailable" });
    return payrollState.settings;
  } });
  // ---- T-052 twins: lane_config report settings and fin.report_cache (with the database guard's rules ported).
  const reportState: { settings: ReportSettings; failSettings: boolean; stored: ReportCacheEntry[]; failStore: { reports: readonly string[] | "all"; kind: "transient" | "provider_error" } | null } = {
    settings: { method: "accrual", period: "year_to_date", classIds: [], kinds: ["pnl", "balance_sheet", "cash_flow", "ar_aging_summary", "ap_aging_summary"] },
    failSettings: false,
    stored: [],
    failStore: null,
  };
  /** Twin of fin.report_cache_guard: top-level keys, 16-level depth, and a string with a letter and 5+ digits in a row. */
  const reportGuardProblem = (payload: unknown): string | null => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "not an object";
    if (Object.keys(payload).some((k) => !["Header", "Columns", "Rows"].includes(k))) return "top-level key";
    let problem: string | null = null;
    const walk = (node: unknown, depth: number) => {
      if (problem) return;
      if (depth >= 16) { problem = "depth"; return; }
      if (typeof node === "string") {
        const t = node.normalize("NFKC");
        if (/[A-Za-z]|[^\p{ASCII}]/u.test(t) && /[0-9]{5}/.test(t)) problem = "value";
      } else if (Array.isArray(node)) for (const x of node) walk(x, depth + 1);
      else if (node && typeof node === "object") for (const x of Object.values(node)) walk(x, depth + 1);
    };
    walk(payload, 0);
    return problem;
  };
  const reportStore: ReportCacheStore = {
    async put(laneId, conn, entry) {
      assertLaneBound(laneId, conn);
      const fail = reportState.failStore;
      if (fail && (fail.reports === "all" || fail.reports.includes(entry.report))) throw new ConnectorError({ kind: fail.kind, message: "Report store unavailable" });
      const row = rowOf(laneId, conn);
      if (row.status !== "active" && row.status !== "degraded") throw new ConnectorError({ kind: "connection_unavailable", message: "The connection is not usable for report storage" });
      if (reportGuardProblem(entry.payload)) throw new ConnectorError({ kind: "provider_error", message: "The report was refused by the report cache" });
      const same = (e: ReportCacheEntry) => e.report === entry.report && e.asOf === entry.asOf && JSON.stringify(Object.entries(e.params).sort()) === JSON.stringify(Object.entries(entry.params).sort());
      const at = reportState.stored.findIndex(same);
      if (at >= 0) reportState.stored[at] = entry;
      else reportState.stored.push(entry);
    },
  };
  const reportsJob = createQboReportsJob({
    loader: { loadConnection: (laneId, id) => connections.load(laneId, id) },
    api,
    store: reportStore,
    settings: async () => {
      if (reportState.failSettings) throw new ConnectorError({ kind: "provider_error", message: "The lane's report settings are not valid" });
      return reportState.settings;
    },
    payroll: async () => {
      if (payrollState.fail) throw new ConnectorError({ kind: "transient", message: "Lane configuration unavailable" });
      return payrollState.settings;
    },
    now,
    logger,
  });
  const revoker = createQuickBooksRevoker({
    provider,
    environment: () => environment,
    client,
    discovery,
    vault,
    connections,
    tokens,
    now,
    httpFor: (laneId, baseUrl) => fastHttp(laneId, undefined, baseUrl),
  });
  const APPROVER = "00000000-0000-4000-8000-0000000000b1";
  /** An approved revoke action for a connection (what the approvals module will hand the writer; T-193 brands it). */
  const approvedRevoke = (laneId: string, conn: { id: string; external_account_id: string }, approvedBy: string = APPROVER) => {
    const action = {
      id: randomUUID(),
      lane_id: laneId,
      connection_id: conn.id,
      action_type: QBO_REVOKE_ACTION,
      target: { realm_id: conn.external_account_id },
      payload: {},
      payload_schema_version: 1,
    };
    return { ...action, payload_sha256: computePayloadSha256(action), approved_by: approvedBy };
  };
  /** Test-only disconnect: the production writer, as the approvals module would call it. */
  const disconnectForTest = async (laneId: string, conn: QboConnection) => {
    await revoker.run(laneId, conn, approvedRevoke(laneId, conn));
    return connections.load(laneId, conn.id);
  };

  // ---- connect state (twin of core.oauth_state_create / _consume): bound to user and lane, single use, 10 minutes.
  const states = new Map<string, { laneId: string; userId: string; provider: string; codeVerifier: string; redirectUri: string; expires: number }>();
  const stateStore: StateStore = {
    async create(c, laneId, prov, stateHash, codeVerifier, redirectUri) {
      states.set(stateHash, { laneId, userId: (c as unknown as { uid: string }).uid, provider: prov, codeVerifier, redirectUri, expires: clock.t + 600_000 });
    },
    async consume(c, laneId, stateHash) {
      const s = states.get(stateHash);
      if (!s || s.laneId !== laneId || s.userId !== (c as unknown as { uid: string }).uid || s.expires <= clock.t) return null;
      states.delete(stateHash);
      return { provider: s.provider, codeVerifier: s.codeVerifier, redirectUri: s.redirectUri };
    },
  };
  const flow = createOAuthFlow({
    providers: [provider],
    states: stateStore,
    connections,
    storeToken: (laneId, conn, secret, expiresAt) => vault.storeToken(laneId, conn, secret, expiresAt),
    audit,
    logger,
    httpFor: (_p, laneId, baseUrl) => fastHttp(laneId, undefined, baseUrl),
  });
  /** Session guard stand-in: the user and the lane client the state store is keyed by. */
  const as = (userId: string) => async (laneId: string) => ({ userId, client: { uid: userId, laneId } as never });

  /** Connects `laneId` through the real callback path against the fake, returning the connection. */
  async function connectViaCallback(laneId: string, userId = "00000000-0000-4000-8000-0000000000a1", realm = FAKE_REALM, code = "synthetic-code-0001") {
    const url = await flow.start("qbo", laneId, as(userId));
    const state = new URL(url).searchParams.get("state") ?? "";
    options.intuit.state.consentRealm = realm; // the user picks this company on Intuit's consent screen
    const result = await flow.callback("qbo", new URLSearchParams({ state, code, realmId: realm }), as(userId));
    if (!result.ok) throw new Error(`harness connect failed: ${result.reason}`);
    return connections.load(laneId, result.connectionId);
  }

  return {
    clock,
    payrollState,
    reportState,
    reportGuardProblem,
    reportsJob,
    logs,
    audits,
    rows,
    secrets,
    realms,
    stats,
    vault,
    connections,
    laneConfig,
    discovery,
    provider,
    tokens,
    newTokenManager,
    api,
    connector,
    flow,
    revoker,
    approvedRevoke,
    disconnectForTest,
    /** Adds a connection of another provider in the lane with a stored credential (a Google-shaped token set). */
    addForeignConnection(laneId: string, providerName: "google" | "stripe" = "google") {
      const row = {
        id: randomUUID(),
        lane_id: laneId,
        provider: providerName,
        external_account_id: "synthetic-foreign-account",
        status: "active",
        features: {},
        features_checked_at: null,
        token_expires_at: null,
        last_sync_at: null,
        last_error: null,
      } as unknown as Row;
      rows.set(row.id, row);
      secrets.set(row.id, JSON.stringify({ access_token: "synthetic-foreign-access-0001", refresh_token: "synthetic-foreign-refresh-0001", expires_in: 3600, obtained_at: new Date(clock.t - 7200_000).toISOString() }));
      return mintLaneBoundConnection({ ...row, features: {} } as never) as unknown as QboConnection;
    },
    states,
    stateHash: hashState,
    as,
    connectViaCallback,
    bind,
    /** The stored token set, parsed (tests only). */
    storedSet(connectionId: string) {
      const text = secrets.get(connectionId);
      return text === undefined ? null : (JSON.parse(text) as Record<string, unknown>);
    },
    /** Replaces the stored set with an expired-access one (same refresh token). */
    expireStoredAccess(connectionId: string) {
      const set = JSON.parse(secrets.get(connectionId) ?? "{}") as Record<string, unknown>;
      secrets.set(connectionId, JSON.stringify({ ...set, obtained_at: new Date(clock.t - 7200_000).toISOString() }));
    },
  };
}

export type QboHarness = ReturnType<typeof createQboHarness>;
