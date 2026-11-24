// A wired Teams client over in-memory twins (T-279 tests only): the REAL Teams guard, token manager, Graph read client, health check, OAuth provider and connect flow, with the
// database-backed pieces (Vault, connection rows and their Teams identity, lane config, the error store, the state store) replaced by in-memory versions, and Microsoft replaced by the
// MSW fake in ./msw/teams. The twins keep the SQL's rules that matter here: lane-checked rows, compare-and-swap rotate, D-23 (one Teams account in one lane), one usable Teams connection
// per person per lane (D0024) and the identity set once. The lane config twin counts every read of anything but `teamsSettings`, so a test can prove the Teams paths never look at the
// mail providers. Every Vault read, every config read and every request to the fake is counted, so a "refused before any call" test can prove that nothing was read and nothing was sent.
import { randomUUID } from "node:crypto";
import type { Audit, AuditEntry } from "@nichols/core/audit";
import type { TeamsFeature } from "@nichols/core/lane-config";
import { ACCOUNT_IN_USE_MESSAGE, ConnectorError, TEAMS_ONE_ACCOUNT_MESSAGE } from "../contract/errors";
import { assertLaneBound, mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import type { Connection, ConnectorErrorInfo } from "../contract/schemas";
import { createApiErrorSink, type ScrubbedApiError } from "../error-log/index";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { classifyGraphFailure } from "../microsoft/errors";
import { createOAuthFlow } from "../oauth/flow";
import type { StateStore } from "../oauth/state";
import { createTeamsApi } from "../teams/api";
import { teamsFeatureKey } from "../teams/constants";
import { createTeamsGuard, type TeamsIdentity } from "../teams/guard";
import { createTeamsHealth } from "../teams/health";
import { createTeamsHttp, createTeamsTokenHttp } from "../teams/http";
import { createTeamsOAuthProvider } from "../teams/provider";
import { createTeamsTokenManager } from "../teams/token-manager";
import type { TeamsSettings } from "../vault/lane-config";
import { SecretValue } from "../vault/secret";
import type { TokenVault } from "../vault/tokens";
import { FAKE_TEAMS_CLIENT_ID, FAKE_TEAMS_CLIENT_SECRET, type FakeTeams, type FakeTeamsAccount, type FakeTeamsGrant } from "./msw/teams/handlers";

type Row = { -readonly [K in keyof Connection<"microsoft_teams">]: Connection<"microsoft_teams">[K] };

/** Synthetic tenant ids (lower-case UUIDs, none of them a real organisation). */
export const TEAMS_TENANT_A = "11111111-1111-4111-8111-111111111111";
export const TEAMS_TENANT_B = "22222222-2222-4222-8222-222222222222";
/** The person who owns directly seeded connections, and the one who connects through the flow by default. */
export const TEAMS_OWNER = "00000000-0000-4000-8000-00000000a279";
export const TEAMS_CONNECT_USER = "00000000-0000-4000-8000-0000000a0279";
export const TEAMS_OTHER_USER = "00000000-0000-4000-8000-0000000b0279";
export const TEAMS_HARNESS_REDIRECT = "http://localhost:3000/api/connect/teams/callback";

export type TeamsLaneSetup = {
  /** `null` = the lane has no `teams` block. */
  teams: Partial<TeamsSettings> | null;
  /** The lane's MAIL providers, recorded only so a test can show they make no difference (the Teams code never reads them). */
  mailProviders?: string[];
};

export type TeamsHarnessOptions = {
  fake: FakeTeams;
  lanes: Record<string, TeamsLaneSetup>;
  maxConcurrent?: number;
  /** Test hook: how long a picture may wait for a slot plus its rate limit (default: the production 5 s). */
  imageMaxWaitMs?: number;
  vault?: Pick<TokenVault, "getToken" | "rotateToken" | "storeToken">;
  now?: () => number;
  /** The redirect URI the Teams provider is configured with (default: the local callback). A wrong one is a configuration error at start. */
  redirectUri?: string;
};

export const defaultTeams = (patch: Partial<TeamsSettings> = {}): TeamsSettings => ({
  enabled: true,
  cloud: "commercial",
  tenantIds: [TEAMS_TENANT_A],
  allowedDomains: ["teams.example.test"],
  features: ["chat_read", "call_links"],
  maxAccountsPerPerson: 1,
  ...patch,
});

export function createTeamsHarness(options: TeamsHarnessOptions) {
  const { fake } = options;
  const logs: LogEntry[] = [];
  const logger = createConnectorLogger({ sink: (e) => logs.push(e) });
  const rows = new Map<string, Row>();
  const identities = new Map<string, TeamsIdentity>();
  const secrets = new Map<string, string>();
  const lanes: Record<string, TeamsLaneSetup> = { ...options.lanes };
  const stats = { tokenReads: 0, rotations: 0, teamsSettingsReads: 0, otherConfigReads: 0, identityReads: 0, loads: 0, stores: 0, identityWrites: 0, featureWrites: 0 };
  /** Every write into a twin store (Vault, identity, features, audit, rows): a "nothing stored" test checks this stays as it was. */
  const writes: { store: string }[] = [];
  const audits: AuditEntry[] = [];
  const audit: Audit = {
    async log(entry) {
      audits.push(entry);
      writes.push({ store: "audit" });
    },
  };
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
      // The connections trigger (T-294): a move INTO "counted" is refused (D0024) beyond the lane's limit; nothing is stored then (the Vault write rolls back with it).
      assertOnePerOwner(laneId, row.id);
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
  const vault = options.vault ?? memoryVault;

  // The lane config twin: ONLY `teamsSettings` is a Teams read; anything else a Teams code path touches is counted (a Proxy), so "the mail providers are never consulted" is provable.
  const settingsOf = (laneId: string): TeamsSettings | null => {
    const l = lanes[laneId];
    if (!l) throw new ConnectorError({ kind: "provider_error", message: "Lane configuration is not valid" });
    return l.teams ? { ...defaultTeams(), ...l.teams } : null;
  };
  const laneConfig = new Proxy(
    {
      async teamsSettings(laneId: string) {
        stats.teamsSettingsReads += 1;
        return settingsOf(laneId);
      },
    } as Record<string, unknown>,
    {
      get(target, key) {
        if (key !== "teamsSettings") stats.otherConfigReads += 1;
        return target[key as string];
      },
    },
  ) as unknown as { teamsSettings(laneId: string): Promise<TeamsSettings | null> };

  const identityReader = {
    async read(_laneId: string, id: string): Promise<TeamsIdentity> {
      stats.identityReads += 1;
      return identities.get(id) ?? { tenantId: null, cloud: null, entraObjectId: null };
    },
  };
  const guard = createTeamsGuard({
    connections: {
      async load(laneId, id) {
        stats.loads += 1;
        const row = rowOf(laneId, { id });
        return mintLaneBoundConnection<"microsoft_teams">({ ...row, features: { ...row.features } });
      },
    },
    laneConfig,
    identity: identityReader,
  });

  const errors = createApiErrorSink({
    store: { async insert(_l, _c, row) { apiErrors.push(row); } },
    messageFor: (info) => classifyGraphFailure(info).message,
    logger,
  });
  const client = () => ({ clientId: FAKE_TEAMS_CLIENT_ID, clientSecret: new SecretValue(FAKE_TEAMS_CLIENT_SECRET) });
  // The HTTP client and its rate limiter run on a virtual clock: a pause advances it, so Retry-After and pacing cost no real time.
  let virtualNow = Date.now();
  const clock = { now: () => virtualNow, waits: [] as number[] };
  const sleep = async (ms: number): Promise<void> => {
    clock.waits.push(ms);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    virtualNow += ms;
  };
  const newTokenManager = () =>
    createTeamsTokenManager({
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
  const httpOptions = { sleep, now: clock.now, retryBaseMs: 1, retryMaxMs: 30_000, random: () => 0.5 };
  const api = createTeamsApi({ guard, tokens, logger, errors, ...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}), ...(options.imageMaxWaitMs ? { imageMaxWaitMs: options.imageMaxWaitMs } : {}), httpOptions });
  const health = createTeamsHealth({ api, ...(options.now ? { now: options.now } : {}) });

  const bind = (row: Row): LaneBoundConnection<"microsoft_teams"> => mintLaneBoundConnection<"microsoft_teams">({ ...row, features: { ...row.features } });
  const featuresFor = (list: readonly TeamsFeature[]): Record<string, boolean> =>
    Object.fromEntries((["chat_read", "chat_send", "call_links", "channels_read", "channels_send"] as const).map((f) => [teamsFeatureKey(f), list.includes(f)]));

  /** A connected, active Teams connection: row, identity, stored token set and the fake's account. */
  function connect(laneId: string, upn: string, opts: { tenant?: string; cloud?: string | null; status?: Row["status"]; features?: readonly TeamsFeature[]; owner?: string; storedAccessExpired?: boolean; noObjectId?: boolean } = {}) {
    const tenant = opts.tenant ?? TEAMS_TENANT_A;
    const account = fake.accountFor(tenant, upn) ?? fake.addAccount(tenant, upn);
    const row: Row = {
      id: randomUUID(),
      lane_id: laneId,
      provider: "microsoft_teams",
      external_account_id: upn,
      status: opts.status ?? "active",
      features: featuresFor(opts.features ?? ["chat_read", "call_links"]),
      features_checked_at: null,
      token_expires_at: null,
      last_sync_at: null,
      last_error: null,
      owner_user_id: opts.owner ?? TEAMS_OWNER,
    };
    rows.set(row.id, row);
    identities.set(row.id, { tenantId: tenant, cloud: opts.cloud === undefined ? "commercial" : opts.cloud, entraObjectId: opts.noObjectId ? null : account.objectId });
    const obtained = opts.storedAccessExpired ? new Date(Date.now() - 2 * 3600_000) : new Date();
    secrets.set(row.id, JSON.stringify({ access_token: fake.issueAccess(account), refresh_token: account.refreshToken, token_type: "Bearer", expires_in: 3599, obtained_at: obtained.toISOString() }));
    return { row, account, conn: bind(row) };
  }
  const storedSet = (connectionId: string) => {
    const t = secrets.get(connectionId);
    return t === undefined ? undefined : (JSON.parse(t) as Record<string, unknown>);
  };

  // ---- The connect flow: the REAL provider and flow over twins of the connection store, the state store and the identity writer.
  const connectConnections = {
    async ensureConnection(laneId: string, provider: string, externalAccountId: string, createdBy?: string) {
      if (provider !== "microsoft_teams") throw new Error("the Teams harness connects Teams rows only");
      let row = [...rows.values()].find((r) => r.lane_id === laneId && r.provider === "microsoft_teams" && r.external_account_id === externalAccountId);
      if (!row) {
        row = { id: randomUUID(), lane_id: laneId, provider: "microsoft_teams", external_account_id: externalAccountId, status: "pending", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: createdBy ?? null };
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
  // core.teams_assert_one_per_owner (T-294): a row that is already counted passes; a move into "counted" is refused (D0024) when the owner's OTHER counted Teams rows in the lane are as many as the lane allows.
  const limitOf = (laneId: string): number => {
    const v = lanes[laneId]?.teams?.maxAccountsPerPerson;
    return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5 ? v : 1;
  };
  const isCounted = (status: Row["status"]) => status !== "disconnected" && status !== "pending";
  const countedOf = (laneId: string, owner: string | null | undefined, exceptId?: string) =>
    [...rows.values()].filter((r) => r.id !== exceptId && r.lane_id === laneId && r.provider === "microsoft_teams" && r.owner_user_id === owner && isCounted(r.status)).length;
  const assertOnePerOwner = (laneId: string, connectionId: string) => {
    const row = rowOf(laneId, { id: connectionId });
    if (isCounted(row.status)) return;
    if (countedOf(laneId, row.owner_user_id, row.id) >= limitOf(laneId)) throw new ConnectorError({ kind: "forbidden", message: TEAMS_ONE_ACCOUNT_MESSAGE });
  };
  const identityWriter = {
    async assertOnePerOwner(laneId: string, connectionId: string) {
      assertOnePerOwner(laneId, connectionId);
    },
    async setOnce(laneId: string, connectionId: string, identity: { tenantId: string; cloud: string; entraObjectId: string }) {
      const row = rowOf(laneId, { id: connectionId });
      if (identities.get(row.id)?.tenantId) throw new ConnectorError({ kind: "forbidden", message: "The tenant of this connection is already recorded" });
      // core.connection_set_teams_identity: one usable Teams connection per person per lane (D0024).
      assertOnePerOwner(laneId, connectionId);
      identities.set(row.id, { tenantId: identity.tenantId, cloud: identity.cloud, entraObjectId: identity.entraObjectId });
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
  const oauthProvider = createTeamsOAuthProvider({
    client: () => ({ clientId: FAKE_TEAMS_CLIENT_ID, clientSecret: new SecretValue(FAKE_TEAMS_CLIENT_SECRET), redirectUri: options.redirectUri ?? TEAMS_HARNESS_REDIRECT }),
    laneConfig,
    identity: identityReader,
    identityWriter,
    // T-294: the person's counted rows (the real one counts through the person's own client under RLS; the twin reads its rows).
    countAccounts: async ({ laneId, userId }) => countedOf(laneId, userId),
    logger,
    ...(options.now ? { now: options.now } : {}),
    tokenHttpFor: (laneId, baseUrl) => createTeamsTokenHttp({ baseUrl, laneId, ...fastOptions }),
    graphHttpFor: (laneId, baseUrl) => createTeamsHttp({ baseUrl, laneId, ...fastOptions }, "commercial", "read"),
  });
  let storeFailure: unknown = null;
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
    upn: string;
    tenant?: string;
    userId?: string;
    connectionId?: string;
    code?: string;
    /** `undefined` = exactly the scopes the authorize request named; a string as is; `null` leaves the field out. */
    scope?: string | null;
    /** Scopes added to the requested ones (Microsoft lists every scope already consented in the tenant). */
    extraScopes?: string;
    refresh?: boolean;
    idToken?: FakeTeamsGrant["idToken"];
    nonce?: string;
    redirectUri?: string;
    profile?: NonNullable<FakeTeamsAccount["profile"]>;
    /** Runs between the start and the callback (T-294: something changed meanwhile, e.g. another account was connected by a second tab; the callback must still enforce the limit). */
    between?: () => void | Promise<void>;
  };
  /** Start + callback through the real flow against the fake. The code is registered with the fake between the two, with the nonce and PKCE challenge of the authorize request. */
  async function connectViaCallback(laneId: string, opts: ConnectOptions) {
    const tenant = opts.tenant ?? TEAMS_TENANT_A;
    const account = fake.accountFor(tenant, opts.upn) ?? fake.addAccount(tenant, opts.upn);
    if (opts.profile) account.profile = opts.profile;
    const userId = opts.userId ?? TEAMS_CONNECT_USER;
    const url = await flow.start("teams", laneId, as(userId), opts.connectionId === undefined ? {} : { connectionId: opts.connectionId });
    const q = new URL(url).searchParams;
    const code = opts.code ?? `synthetic-teams-code-${randomUUID()}`;
    const challenge = q.get("code_challenge");
    const nonce = opts.nonce ?? q.get("nonce");
    const requested = q.get("scope") ?? "";
    fake.grant(code, {
      account,
      ...(challenge ? { codeChallenge: challenge } : {}),
      ...(nonce ? { nonce } : {}),
      redirectUri: opts.redirectUri ?? q.get("redirect_uri") ?? "",
      scope: opts.scope === undefined ? `${requested}${opts.extraScopes ? ` ${opts.extraScopes}` : ""}` : opts.scope,
      ...(opts.refresh !== undefined ? { refresh: opts.refresh } : {}),
      ...(opts.idToken !== undefined ? { idToken: opts.idToken } : {}),
    });
    const state = q.get("state") ?? "";
    await opts.between?.();
    const result = await flow.callback("teams", new URLSearchParams({ state, code }), as(userId));
    return { url, state, code, result };
  }
  const writeCount = () => writes.length;
  const everyRequest = () => fake.state.tokenRequests.length + fake.state.graphRequests.length;

  return {
    api, guard, tokens, health, newTokenManager, clock, laneConfig, connect, bind, rows, identities, secrets, lanes, stats, logs, apiErrors, reconnects, storedSet, everyRequest,
    flow, failStoreOnce, as, states, audits, writes, writeCount, connectViaCallback, oauthProvider, vault, httpOptions, errors, logger, identityReader,
    setLane(laneId: string, patch: Partial<TeamsLaneSetup>) {
      lanes[laneId] = { ...(lanes[laneId] as TeamsLaneSetup), ...patch };
    },
    setIdentity(connectionId: string, identity: TeamsIdentity) {
      identities.set(connectionId, identity);
    },
  };
}
export type TeamsHarness = ReturnType<typeof createTeamsHarness>;
