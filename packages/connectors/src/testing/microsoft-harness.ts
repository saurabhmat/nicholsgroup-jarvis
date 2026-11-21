// A wired Microsoft client over in-memory twins (T-256 tests only): the real guard, token manager, Graph client, health check and
// error log, with the database-backed pieces (Vault, connection rows and their Microsoft identity, lane config, the error store)
// replaced by in-memory versions, and Microsoft replaced by the MSW fake in ./msw/microsoft. The Vault twin keeps the SQL's rules
// (lane checked, compare-and-swap rotate). Every Vault read, every lane-config read and every request to the fake is counted, so a
// "refused before any call" test can prove that nothing was read and nothing was sent, not only that an error was thrown.
import { randomUUID } from "node:crypto";
import type { Audit, AuditEntry } from "@nichols/core/audit";
import { ACCOUNT_IN_USE_MESSAGE, ConnectorError } from "../contract/errors";
import { assertLaneBound, mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import type { Connection, ConnectorErrorInfo } from "../contract/schemas";
import { createApiErrorSink, type ScrubbedApiError } from "../error-log/index";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { createGraphApi } from "../microsoft/api";
import { classifyGraphFailure } from "../microsoft/errors";
import { createMicrosoftGuard } from "../microsoft/guard";
import { createMicrosoftHealth } from "../microsoft/health";
import { createGraphHttp } from "../microsoft/http";
import { createMicrosoftOAuthProvider } from "../microsoft/provider";
import { createMicrosoftTokenManager } from "../microsoft/token-manager";
import { createOAuthFlow } from "../oauth/flow";
import type { StateStore } from "../oauth/state";
import type { MailProvider, MicrosoftSettings } from "../vault/lane-config";
import { SecretValue } from "../vault/secret";
import type { TokenVault } from "../vault/tokens";
import { FAKE_GRAPH_CLIENT_ID, FAKE_GRAPH_CLIENT_SECRET, type FakeGrant, type FakeMicrosoft, type FakeMsAccount } from "./msw/microsoft/handlers";

type Row = { -readonly [K in keyof Connection<"microsoft">]: Connection<"microsoft">[K] };

/** Synthetic tenant ids (lower-case UUIDs, none of them a real organisation). */
export const TENANT_A = "11111111-1111-4111-8111-111111111111";
export const TENANT_B = "22222222-2222-4222-8222-222222222222";
export const TENANT_C = "33333333-3333-4333-8333-333333333333";
export const HARNESS_OWNER = "00000000-0000-4000-8000-00000000b256";
/** The user who connects through the flow by default (T-066). */
export const CONNECT_USER = "00000000-0000-4000-8000-0000000b0066";
export const HARNESS_REDIRECT = "http://localhost:3000/api/connect/microsoft/callback";

export type LaneSetup = {
  providers: MailProvider[];
  /** `null` = the lane has no `microsoft` block. */
  microsoft: Partial<MicrosoftSettings> | null;
  domains: string[];
  mailboxes?: string[];
};

export type MicrosoftHarnessOptions = {
  fake: FakeMicrosoft;
  lanes: Record<string, LaneSetup>;
  maxConcurrent?: number;
  /**
   * Replaces the in-memory Vault twin (T-066: a test can put the REAL `createTokenVault` over an RPC twin of the SQL functions, to prove a
   * stored Microsoft token is read and rotated through that path). The harness's `secrets` map is the store the twin must use.
   */
  vault?: Pick<TokenVault, "getToken" | "rotateToken" | "storeToken">;
  /** Lanes whose policy allows email writes (`write_actions_allowed` has email_send or email_draft): the connect then asks for the write scopes (T-066). Default: none. */
  writeLanes?: readonly string[];
  /**
   * What a pause of the shared client (Retry-After waits, backoff) and of the rate limiter does besides advancing the harness's
   * virtual clock (the HTTP client and its limiter run on that clock, so a test never waits in real time). Default: yield once.
   */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultMicrosoft = (tenants: string[]): MicrosoftSettings => ({ cloud: "commercial", tenantIds: tenants, allowGcc: false, mailFolders: ["inbox", "sentitems"] as MicrosoftSettings["mailFolders"], calendarIds: null });

export function createMicrosoftHarness(options: MicrosoftHarnessOptions) {
  const { fake } = options;
  const logs: LogEntry[] = [];
  const logger = createConnectorLogger({ sink: (e) => logs.push(e) });
  const rows = new Map<string, Row>();
  const identities = new Map<string, { tenantId: string | null; cloud: string | null }>();
  const secrets = new Map<string, string>();
  const lanes: Record<string, LaneSetup> = { ...options.lanes };
  const stats = { tokenReads: 0, rotations: 0, settingsReads: 0, identityReads: 0, loads: 0, stores: 0, identityWrites: 0, featureWrites: 0, domainReads: 0 };
  /** Every write into a twin store (Vault, identity, features, audit): a "nothing stored" test checks this stays as it was. */
  const writes: { store: string }[] = [];
  const audits: AuditEntry[] = [];
  const audit: Audit = {
    async log(entry) {
      audits.push(entry);
      writes.push({ store: "audit" });
    },
  };
  const writeLanes = new Set(options.writeLanes ?? []);
  const apiErrors: ScrubbedApiError[] = [];
  const reconnects: ConnectorErrorInfo[] = [];

  const rowOf = (laneId: string, conn: { id: string }): Row => {
    const row = rows.get(conn.id);
    if (!row || row.lane_id !== laneId) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
    return row;
  };

  const memoryVault: Pick<TokenVault, "getToken" | "rotateToken" | "storeToken"> = {
    async storeToken(laneId, conn, secret, expiresAt) {
      assertLaneBound(laneId, conn);
      const row = rowOf(laneId, conn);
      // D-23 (one account, one lane) is per provider and ignores pending rows, as the SQL index does.
      const holder = [...rows.values()].find((r) => r.id !== row.id && r.provider === row.provider && r.external_account_id.toLowerCase() === row.external_account_id.toLowerCase() && r.status !== "disconnected" && r.status !== "pending" && r.lane_id !== laneId);
      if (holder) throw new ConnectorError({ kind: "forbidden", message: ACCOUNT_IN_USE_MESSAGE });
      secrets.set(row.id, secret.reveal());
      writes.push({ store: "token_store" });
      row.status = "active";
      row.token_expires_at = expiresAt ? expiresAt.toISOString() : null;
      stats.stores += 1;
    },
    async getToken(laneId, conn) {
      assertLaneBound(laneId, conn);
      stats.tokenReads += 1;
      const row = rowOf(laneId, conn);
      const text = secrets.get(row.id);
      if (text === undefined) throw new ConnectorError({ kind: "not_found", message: "No stored credential for this connection" });
      return new SecretValue(text);
    },
    async rotateToken(laneId, conn, secret, _expiresAt, replaces) {
      assertLaneBound(laneId, conn);
      const row = rowOf(laneId, conn);
      if (secrets.get(row.id) !== replaces.reveal()) return false;
      secrets.set(row.id, secret.reveal());
      writes.push({ store: "token_store" });
      stats.rotations += 1;
      return true;
    },
  };

  const vault: Pick<TokenVault, "getToken" | "rotateToken" | "storeToken"> = options.vault ?? memoryVault;

  const laneConfig = {
    async mailProviderSettings(laneId: string) {
      stats.settingsReads += 1;
      const l = lanes[laneId];
      if (!l) throw new ConnectorError({ kind: "provider_error", message: "Lane configuration is not valid" });
      return { providers: [...l.providers], microsoft: l.microsoft ? { ...defaultMicrosoft([]), ...l.microsoft } : null };
    },
    async mailboxes(laneId: string) {
      return (lanes[laneId]?.mailboxes ?? []).map((m) => m.toLowerCase());
    },
    async mailDomains(laneId: string) {
      stats.domainReads += 1;
      return [...(lanes[laneId]?.domains ?? [])];
    },
  };

  const guard = createMicrosoftGuard({
    connections: {
      async load(laneId, id) {
        stats.loads += 1;
        const row = rowOf(laneId, { id });
        return mintLaneBoundConnection<"microsoft">({ ...row, features: { ...row.features } });
      },
    },
    laneConfig,
    identity: {
      async read(_laneId, id) {
        stats.identityReads += 1;
        return identities.get(id) ?? { tenantId: null, cloud: null };
      },
    },
  });

  const errors = createApiErrorSink({
    store: { async insert(_l, _c, row) { apiErrors.push(row); } },
    messageFor: (info) => classifyGraphFailure(info).message,
    logger,
  });

  const client = () => ({ clientId: FAKE_GRAPH_CLIENT_ID, clientSecret: new SecretValue(FAKE_GRAPH_CLIENT_SECRET) });
  // The HTTP client and its rate limiter run on a virtual clock: a pause advances it, so Retry-After and 4 requests/s cost no real time.
  let virtualNow = Date.now();
  const clock = { now: () => virtualNow, waits: [] as number[] };
  const sleep = async (ms: number): Promise<void> => {
    clock.waits.push(ms);
    if (options.sleep) await options.sleep(ms);
    else await new Promise<void>((resolve) => setTimeout(resolve, 0));
    virtualNow += ms;
  };
  const newTokenManager = () =>
    createMicrosoftTokenManager({
      vault,
      client,
      logger,
      sleep,
      ...(options.now ? { now: options.now } : {}),
      onReconnectRequired: async (_l, _c, e) => {
        reconnects.push(e);
      },
    });
  const tokens = newTokenManager();
  const api = createGraphApi({
    guard,
    tokens,
    logger,
    errors,
    ...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}),
    httpOptions: { sleep, now: clock.now, retryBaseMs: 1, retryMaxMs: 30_000, random: () => 0.5 },
  });
  const health = createMicrosoftHealth({ api, ...(options.now ? { now: options.now } : {}) });

  /** A connected, active Microsoft mailbox: row, identity, stored token set and the fake's account. */
  function connect(laneId: string, address: string, opts: { tenant?: string; cloud?: string | null; status?: Row["status"]; storedAccessExpired?: boolean } = {}) {
    const tenant = opts.tenant ?? TENANT_A;
    const account = fake.accountFor(tenant, address) ?? fake.addAccount(tenant, address);
    const row: Row = {
      id: randomUUID(),
      lane_id: laneId,
      provider: "microsoft",
      external_account_id: address,
      status: opts.status ?? "active",
      features: {},
      features_checked_at: null,
      token_expires_at: null,
      last_sync_at: null,
      last_error: null,
      owner_user_id: HARNESS_OWNER,
    };
    rows.set(row.id, row);
    identities.set(row.id, { tenantId: tenant, cloud: opts.cloud === undefined ? "commercial" : opts.cloud });
    const obtained = opts.storedAccessExpired ? new Date(Date.now() - 2 * 3600_000) : new Date();
    secrets.set(row.id, JSON.stringify({ access_token: fake.issueAccess(account), refresh_token: account.refreshToken, token_type: "Bearer", expires_in: 3599, obtained_at: obtained.toISOString() }));
    return { row, account, conn: bind(row) };
  }
  const bind = (row: Row): LaneBoundConnection<"microsoft"> => mintLaneBoundConnection<"microsoft">({ ...row, features: { ...row.features } });

  const storedSet = (connectionId: string) => {
    const t = secrets.get(connectionId);
    return t === undefined ? undefined : (JSON.parse(t) as Record<string, unknown>);
  };
  /** Make the stored access token look expired (obtained two hours ago) without changing the tokens. */
  const expireStoredAccess = (connectionId: string) => {
    const set = storedSet(connectionId);
    if (set) secrets.set(connectionId, JSON.stringify({ ...set, obtained_at: new Date(Date.now() - 2 * 3600_000).toISOString() }));
  };

  // ---- The connect flow (T-066): the REAL provider and flow over twins of the connection store, the state store and the identity writer.
  const connectConnections = {
    async ensureConnection(laneId: string, provider: string, externalAccountId: string, createdBy?: string) {
      if (provider !== "microsoft") throw new Error("the Microsoft harness connects Microsoft rows only");
      let row = [...rows.values()].find((r) => r.lane_id === laneId && r.provider === "microsoft" && r.external_account_id === externalAccountId);
      if (!row) {
        row = { id: randomUUID(), lane_id: laneId, provider: "microsoft", external_account_id: externalAccountId, status: "pending", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: createdBy ?? null };
        rows.set(row.id, row);
        writes.push({ store: "connection_row" });
      }
      return bind(row) as LaneBoundConnection;
    },
    async findById(laneId: string, provider: string, id: string) {
      const row = rows.get(id);
      if (!row || row.lane_id !== laneId || row.provider !== provider) return null;
      return { id: row.id, externalAccountId: row.external_account_id, status: row.status, ownerUserId: row.owner_user_id ?? null };
    },
    async setFeatures(laneId: string, conn: { id: string }, features: Record<string, boolean>) {
      const row = rowOf(laneId, conn);
      row.features = { ...row.features, ...features };
      stats.featureWrites += 1;
      writes.push({ store: "features" });
    },
  };
  const identityWriter = {
    async setOnce(laneId: string, connectionId: string, tenantId: string, cloud: string) {
      const row = rowOf(laneId, { id: connectionId });
      const current = identities.get(row.id);
      if (current?.tenantId) throw new ConnectorError({ kind: "forbidden", message: "The tenant of this connection is already recorded" });
      identities.set(row.id, { tenantId, cloud });
      stats.identityWrites += 1;
      writes.push({ store: "identity" });
    },
  };
  const states = new Map<string, { laneId: string; userId: string; provider: string; codeVerifier: string; redirectUri: string; expires: number }>();
  const stateStore: StateStore = {
    async create(c, laneId, prov, stateHash, codeVerifier, redirectUri) {
      states.set(stateHash, { laneId, userId: (c as unknown as { uid: string }).uid, provider: prov, codeVerifier, redirectUri, expires: Date.now() + 600_000 });
      writes.push({ store: "state" });
    },
    async consume(c, laneId, stateHash) {
      const st = states.get(stateHash);
      if (!st || st.laneId !== laneId || st.userId !== (c as unknown as { uid: string }).uid || st.expires <= Date.now()) return null;
      states.delete(stateHash);
      return { provider: st.provider, codeVerifier: st.codeVerifier, redirectUri: st.redirectUri };
    },
  };
  const fastOptions = { retryBaseMs: 1, retryMaxMs: 5, maxRetries: 1, sleep, now: clock.now, random: () => 0.5, logger } as const;
  const oauthProvider = createMicrosoftOAuthProvider({
    client: () => ({ clientId: FAKE_GRAPH_CLIENT_ID, clientSecret: new SecretValue(FAKE_GRAPH_CLIENT_SECRET), redirectUri: HARNESS_REDIRECT }),
    laneConfig,
    identity: { async read(_laneId, id) { stats.identityReads += 1; return identities.get(id) ?? { tenantId: null, cloud: null }; } },
    identityWriter,
    writesAllowed: async (laneId) => writeLanes.has(laneId),
    logger,
    ...(options.now ? { now: options.now } : {}),
    tokenHttpFor: (laneId, baseUrl) => createGraphHttp({ baseUrl, laneId, ...fastOptions }, "commercial", "token"),
    graphHttpFor: (laneId, baseUrl) => createGraphHttp({ baseUrl, laneId, ...fastOptions }, "commercial", "api"),
  });
  let storeFailure: unknown = null;
  /** The next token store (the Vault write at the end of a connect) fails with this error, once. */
  const failStoreOnce = (e: unknown) => {
    storeFailure = e;
  };
  const flow = createOAuthFlow({
    providers: [oauthProvider],
    states: stateStore,
    connections: connectConnections,
    storeToken: async (laneId, conn, secret, expiresAt, actorUserId) => {
      if (storeFailure !== null) {
        const e = storeFailure;
        storeFailure = null;
        throw e;
      }
      await vault.storeToken(laneId, conn, secret, expiresAt, actorUserId);
    },
    audit,
    logger,
  });
  const as = (userId: string) => async (laneId: string) => ({ userId, client: { uid: userId, laneId } as never });

  type ConnectOptions = {
    address: string;
    tenant?: string;
    /** The user who connects (default CONNECT_USER). */
    userId?: string;
    /** Reconnect this connection. */
    connectionId?: string;
    code?: string;
    scope?: string | null;
    refresh?: boolean;
    idToken?: FakeGrant["idToken"];
    /** The nonce the fake puts in the id_token (default: the one on the authorize request). */
    nonce?: string;
    /** Passed to the fake: the default scope also lists `openid offline_access profile`. */
    oidcScopes?: boolean;
    /** The redirect URI the fake expects (default: the one on the authorize request). */
    redirectUri?: string;
    profile?: NonNullable<FakeMsAccount["profile"]>;
  };
  /** Start + callback through the real flow against the fake. The code is registered with the fake between the two, with the nonce and PKCE challenge of the authorize request. */
  async function connectViaCallback(laneId: string, opts: ConnectOptions) {
    const tenant = opts.tenant ?? TENANT_A;
    const account = fake.accountFor(tenant, opts.address) ?? fake.addAccount(tenant, opts.address);
    if (opts.profile) account.profile = opts.profile;
    const userId = opts.userId ?? CONNECT_USER;
    const url = await flow.start("microsoft", laneId, as(userId), opts.connectionId === undefined ? {} : { connectionId: opts.connectionId });
    const q = new URL(url).searchParams;
    const code = opts.code ?? `synthetic-ms-code-${randomUUID()}`;
    const challenge = q.get("code_challenge");
    const nonce = opts.nonce ?? q.get("nonce");
    fake.grant(code, {
      account,
      ...(challenge ? { codeChallenge: challenge } : {}),
      ...(nonce ? { nonce } : {}),
      redirectUri: opts.redirectUri ?? q.get("redirect_uri") ?? "",
      ...(opts.oidcScopes ? { oidcScopes: true } : {}),
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      ...(opts.refresh !== undefined ? { refresh: opts.refresh } : {}),
      ...(opts.idToken !== undefined ? { idToken: opts.idToken } : {}),
    });
    const state = q.get("state") ?? "";
    const result = await flow.callback("microsoft", new URLSearchParams({ state, code }), as(userId));
    return { url, state, code, result };
  }
  /** A snapshot of every counter that a refusal must leave unchanged. */
  const writeCount = () => writes.length;

  const everyRequest = () => fake.state.tokenRequests.length + fake.state.graphRequests.length;

  return {
    api, guard, tokens, health, newTokenManager, clock, laneConfig, connect, bind, rows, identities, secrets, lanes, stats, logs, apiErrors, reconnects, storedSet, expireStoredAccess, everyRequest,
    flow, failStoreOnce, as, states, audits, writes, writeCount, connectViaCallback, writeLanes, oauthProvider,
    /** Changes a lane's configuration (a tenant or the provider removed, a second provider added...). */
    setLane(laneId: string, patch: Partial<LaneSetup>) {
      lanes[laneId] = { ...(lanes[laneId] as LaneSetup), ...patch };
    },
    setIdentity(connectionId: string, identity: { tenantId: string | null; cloud: string | null }) {
      identities.set(connectionId, identity);
    },
    defaultMicrosoft,
  };
}
export type MicrosoftHarness = ReturnType<typeof createMicrosoftHarness>;
