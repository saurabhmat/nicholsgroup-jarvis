// A wired Microsoft client over in-memory twins (T-256 tests only): the real guard, token manager, Graph client, health check and
// error log, with the database-backed pieces (Vault, connection rows and their Microsoft identity, lane config, the error store)
// replaced by in-memory versions, and Microsoft replaced by the MSW fake in ./msw/microsoft. The Vault twin keeps the SQL's rules
// (lane checked, compare-and-swap rotate). Every Vault read, every lane-config read and every request to the fake is counted, so a
// "refused before any call" test can prove that nothing was read and nothing was sent, not only that an error was thrown.
import { randomUUID } from "node:crypto";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound, mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import type { Connection, ConnectorErrorInfo } from "../contract/schemas";
import { createApiErrorSink, type ScrubbedApiError } from "../error-log/index";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { createGraphApi } from "../microsoft/api";
import { classifyGraphFailure } from "../microsoft/errors";
import { createMicrosoftGuard } from "../microsoft/guard";
import { createMicrosoftHealth } from "../microsoft/health";
import { createMicrosoftTokenManager } from "../microsoft/token-manager";
import type { MailProvider, MicrosoftSettings } from "../vault/lane-config";
import { SecretValue } from "../vault/secret";
import type { TokenVault } from "../vault/tokens";
import { FAKE_GRAPH_CLIENT_ID, FAKE_GRAPH_CLIENT_SECRET, type FakeMicrosoft } from "./msw/microsoft/handlers";

type Row = { -readonly [K in keyof Connection<"microsoft">]: Connection<"microsoft">[K] };

/** Synthetic tenant ids (lower-case UUIDs, none of them a real organisation). */
export const TENANT_A = "11111111-1111-4111-8111-111111111111";
export const TENANT_B = "22222222-2222-4222-8222-222222222222";
export const TENANT_C = "33333333-3333-4333-8333-333333333333";
export const HARNESS_OWNER = "00000000-0000-4000-8000-00000000b256";

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
  const stats = { tokenReads: 0, rotations: 0, settingsReads: 0, identityReads: 0, loads: 0 };
  const apiErrors: ScrubbedApiError[] = [];
  const reconnects: ConnectorErrorInfo[] = [];

  const rowOf = (laneId: string, conn: { id: string }): Row => {
    const row = rows.get(conn.id);
    if (!row || row.lane_id !== laneId) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
    return row;
  };

  const vault: Pick<TokenVault, "getToken" | "rotateToken"> = {
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
      stats.rotations += 1;
      return true;
    },
  };

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
  const everyRequest = () => fake.state.tokenRequests.length + fake.state.graphRequests.length;

  return {
    api, guard, tokens, health, newTokenManager, clock, connect, bind, rows, identities, secrets, lanes, stats, logs, apiErrors, reconnects, storedSet, expireStoredAccess, everyRequest,
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
