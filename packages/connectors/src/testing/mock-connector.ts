// In-memory mock connector with synthetic data only. Passes the contract kit; used by the kit's own tests and by later
// job tests (T-038 conn.sync, T-113 counting executor). It never makes network calls.
//
// It behaves like a real connector should: its store is the authority for lane and status, tokens are keyed by
// (lane, connection id), and every call re-reads both.
import { randomUUID } from "node:crypto";
import type { LaneId } from "@nichols/core";
import type { Connector } from "../contract/connector";
import { ConnectorError } from "../contract/errors";
import { assertStatusUsable } from "../contract/guards";
import { assertLaneBound, mintLaneBoundConnection, type ConnectionLoader, type LaneBoundConnection } from "../contract/lane-bound";
import {
  ConnectInputSchema,
  LaneIdSchema,
  ReadOpSchema,
  SyncCursorSchema,
  SyncOptionsSchema,
  WriteIntentSchema,
  type Connection,
  type HealthStatus,
  type RawRecord,
  type SyncSummary,
} from "../contract/schemas";
import type { ContractHarness } from "./contract-kit";
import { TEST_PROVIDER, testSchemas } from "./test-provider";

/** Synthetic authorization code the mock accepts. */
export const MOCK_AUTH_CODE = "synthetic-auth-code";
/** Synthetic token the mock "stores in the Vault". The contract kit fails if it ever appears in an output. */
export const MOCK_SECRET_CANARY = "canary-token-0f3c9a7e-not-a-real-secret";
export const MOCK_ACCOUNT_ID = "mock-account-1";

const READ_OPS = ["mock.echo", "mock.summary"] as const;
const FEATURE_KEYS = ["class_tracking", "multicurrency"] as const;
const OBJECT_TYPE = "MockItem";
const WRITE_ACTION = "mock.item.update";
const BASE_TIME = Date.parse("2026-10-01T00:00:00.000Z");
const BATCH_SIZE = 2;

type MockProvider = typeof TEST_PROVIDER;
type MockConnection = LaneBoundConnection<MockProvider>;

/** Deliberately broken behaviours, only for proving the contract kit catches them. */
export interface MockFaults {
  /** `prepareWrite` counts as an external write. */
  prepareWriteExecutes?: boolean;
  /** `connect` accepts a `reconnect_connection_id` from another lane. */
  crossLaneReconnect?: boolean;
  /** Trust the caller's `status` instead of the stored row. */
  trustCallerStatus?: boolean;
}

export interface MockConnectorOptions {
  /** Omit `prepareWrite` (like QuickBooks and Stripe). Default false. */
  readOnly?: boolean;
  /** Include `sync`. Default true. */
  sync?: boolean;
  /** Include `subscribe`. Default true. */
  subscribe?: boolean;
  /** Synthetic records returned by a full sync. Default 3. */
  recordCount?: number;
  now?: () => Date;
  faults?: MockFaults;
}

export interface MockSetup {
  connector: Connector<MockProvider>;
  loader: ConnectionLoader<MockProvider>;
  /** Writes made against the (pretend) provider, including revocations on disconnect. */
  externalWriteCount(): number;
  /** Mark the stored row `reconnect_required` (as T-195 does after `invalid_grant`). */
  markReconnectRequired(conn: { id: string; lane_id: string }): void;
  /** Make the provider answer `invalid_grant` on the next token use for this connection. */
  simulateInvalidGrant(conn: { id: string; lane_id: string }): void;
}

interface VaultEntry {
  token: string;
  invalidGrant: boolean;
}

export function createMockConnector(options: MockConnectorOptions = {}): MockSetup {
  const now = options.now ?? (() => new Date());
  const recordCount = options.recordCount ?? 3;
  const faults = options.faults ?? {};
  const store = new Map<string, Connection<MockProvider>>(); // authoritative rows (core.connections stand-in)
  const vault = new Map<string, VaultEntry>(); // key: lane + connection id
  let externalWrites = 0;
  let tid = 0;
  const nextTid = () => `mock-tid-${++tid}`;
  const vaultKey = (laneId: LaneId, id: string) => `${laneId}\u0000${id}`;
  const bind = (row: Connection<MockProvider>): MockConnection =>
    mintLaneBoundConnection<MockProvider>({ ...row, features: { ...row.features } }, testSchemas.ConnectionSchema as never);

  const notFound = () => new ConnectorError({ kind: "not_found", message: "Connection not found" });

  /** Brand + lane check, then the authoritative row for (laneId, id). */
  function loadRow(laneId: LaneId, conn: unknown): Connection<MockProvider> {
    assertLaneBound(laneId, conn);
    const row = store.get(conn.id);
    if (!row || row.lane_id !== laneId) throw notFound();
    return row;
  }

  /** Authoritative status check, then the token (raises reconnect_required on invalid_grant). */
  function useConnection(laneId: LaneId, conn: unknown): Connection<MockProvider> {
    const row = loadRow(laneId, conn);
    assertStatusUsable(faults.trustCallerStatus ? (conn as MockConnection).status : row.status);
    const entry = vault.get(vaultKey(laneId, row.id));
    if (!entry || entry.invalidGrant) {
      row.status = "reconnect_required";
      throw new ConnectorError({ kind: "reconnect_required", message: "Provider rejected the refresh token", http_status: 400, provider_error_code: "invalid_grant", provider_tid: nextTid() });
    }
    return row;
  }

  const loader: ConnectionLoader<MockProvider> = {
    async loadConnection(laneId, connectionId) {
      if (!LaneIdSchema.safeParse(laneId).success) throw new ConnectorError({ kind: "invalid_input", message: "laneId is required" });
      const row = store.get(connectionId);
      if (!row || row.lane_id !== laneId) throw notFound();
      return bind(row);
    },
  };

  const connector: Connector<MockProvider> = {
    provider: TEST_PROVIDER,
    capabilities: { sync: options.sync ?? true, subscribe: options.subscribe ?? true, prepareWrite: !(options.readOnly ?? false) },
    readOps: READ_OPS,
    featureKeys: FEATURE_KEYS,

    async connect(laneId, input) {
      if (!LaneIdSchema.safeParse(laneId).success) throw new ConnectorError({ kind: "invalid_input", message: "laneId is required" });
      const parsed = ConnectInputSchema.safeParse(input);
      if (!parsed.success) throw new ConnectorError({ kind: "invalid_input", message: "Invalid connect input" });
      const data = parsed.data;
      if (data.kind !== "oauth_code") throw new ConnectorError({ kind: "invalid_input", message: "Unsupported connect input" });
      if (data.code !== MOCK_AUTH_CODE) {
        throw new ConnectorError({ kind: "forbidden", message: "Authorization code rejected", http_status: 400, provider_tid: nextTid() });
      }
      const account = data.external_account_id ?? MOCK_ACCOUNT_ID;
      const at = now();
      let row: Connection<MockProvider>;
      if (data.reconnect_connection_id !== undefined) {
        const existing = store.get(data.reconnect_connection_id);
        if (!existing || (existing.lane_id !== laneId && !faults.crossLaneReconnect)) throw notFound();
        if (existing.provider !== TEST_PROVIDER || existing.external_account_id !== account) {
          throw new ConnectorError({ kind: "invalid_input", message: "Reconnect must use the same provider account" });
        }
        row = existing;
      } else {
        row = {
          id: randomUUID(),
          lane_id: laneId,
          provider: TEST_PROVIDER,
          external_account_id: account,
          status: "pending",
          features: {},
          features_checked_at: null,
          token_expires_at: null,
          last_sync_at: null,
          last_error: null,
        };
        store.set(row.id, row);
      }
      vault.set(vaultKey(row.lane_id, row.id), { token: MOCK_SECRET_CANARY, invalidGrant: false });
      Object.assign(row, {
        status: "active",
        features: { class_tracking: true, multicurrency: false },
        features_checked_at: at.toISOString(),
        token_expires_at: new Date(at.getTime() + 3600_000).toISOString(),
        last_error: null,
      });
      return bind(row);
    },

    async health(laneId, conn): Promise<HealthStatus> {
      const row = loadRow(laneId, conn);
      const checked_at = now().toISOString();
      try {
        useConnection(laneId, conn);
      } catch (e) {
        const error = e instanceof ConnectorError ? e : new ConnectorError({ kind: "provider_error", message: "Health check failed" });
        return { ok: false, status: row.status === "disconnected" ? "disconnected" : row.status, checked_at, provider_tid: error.info.provider_tid, error: error.toJSON() };
      }
      return { ok: true, status: "active", checked_at, features: { class_tracking: true, multicurrency: false }, provider_tid: nextTid(), error: null };
    },

    async read<T = unknown>(laneId: LaneId, conn: MockConnection, op: Parameters<Connector["read"]>[2]) {
      const row = useConnection(laneId, conn);
      const parsed = ReadOpSchema.safeParse(op);
      if (!parsed.success) throw new ConnectorError({ kind: "invalid_input", message: "Invalid read op" });
      const { op: name, params } = parsed.data;
      if (!(READ_OPS as readonly string[]).includes(name)) {
        throw new ConnectorError({ kind: "unsupported_op", message: `Unsupported read op ${name}` });
      }
      const at = now().toISOString();
      const data = name === "mock.echo" ? { params } : { total: "123.45", currency: "USD" };
      return {
        lane_id: laneId,
        provider: TEST_PROVIDER,
        connection_id: row.id,
        op: name,
        data: data as T,
        as_of: at,
        fetched_at: at,
        freshness: "live" as const,
        provider_tid: nextTid(),
        source_refs: [{ kind: "mock_object", ref: `${name}:1` }],
        notes: [],
      };
    },

    async disconnect(laneId, conn) {
      const row = loadRow(laneId, conn);
      if (vault.delete(vaultKey(laneId, row.id))) externalWrites += 1; // provider revoke call
      row.status = "disconnected";
      row.token_expires_at = null;
      return bind(row);
    },
  };

  if (connector.capabilities.sync) {
    connector.sync = async (laneId, conn, cursor, sink, syncOptions): Promise<SyncSummary> => {
      const row = useConnection(laneId, conn);
      const opts = SyncOptionsSchema.safeParse(syncOptions ?? {});
      if (!opts.success) throw new ConnectorError({ kind: "invalid_input", message: "Invalid sync options" });
      let since = Number.NEGATIVE_INFINITY;
      if (cursor !== null) {
        const parsedCursor = SyncCursorSchema.safeParse(cursor);
        since = parsedCursor.success ? Date.parse(parsedCursor.data.value) : Number.NaN;
        if (Number.isNaN(since)) throw new ConnectorError({ kind: "invalid_input", message: "Invalid sync cursor" });
      }
      const wanted = opts.data.objectTypes;
      const syncedAt = now().toISOString();
      let latest = cursor === null ? BASE_TIME : since;
      const records: RawRecord<MockProvider>[] = [];
      if (wanted === undefined || wanted.includes(OBJECT_TYPE)) {
        for (let i = 1; i <= recordCount; i += 1) {
          const updated = BASE_TIME + i * 60_000;
          if (updated <= since) continue;
          latest = Math.max(latest, updated);
          records.push({
            lane_id: laneId,
            provider: TEST_PROVIDER,
            connection_id: row.id,
            object_type: OBJECT_TYPE,
            external_id: `mock-item-${i}`,
            payload: { id: `mock-item-${i}`, name: `Synthetic item ${i}`, amount: "10.00" },
            source_updated_at: new Date(updated).toISOString(),
            deleted: false,
            synced_at: syncedAt,
          });
        }
      }
      for (let i = 0; i < records.length; i += BATCH_SIZE) await sink(records.slice(i, i + BATCH_SIZE));
      row.last_sync_at = syncedAt;
      return { cursor: { value: new Date(latest).toISOString() }, mode: cursor === null ? "full" : "incremental", records: records.length, provider_tid: nextTid() };
    };
  }

  if (connector.capabilities.subscribe) {
    connector.subscribe = async (laneId, conn) => {
      const row = useConnection(laneId, conn);
      const at = now();
      return {
        id: `mock-sub-${row.id}`,
        lane_id: laneId,
        provider: TEST_PROVIDER,
        connection_id: row.id,
        kind: "webhook" as const,
        expires_at: new Date(at.getTime() + 7 * 86400_000).toISOString(),
        created_at: at.toISOString(),
      };
    };
  }

  if (connector.capabilities.prepareWrite) {
    connector.prepareWrite = async (laneId, conn, intent) => {
      const row = useConnection(laneId, conn);
      const parsed = WriteIntentSchema.safeParse(intent);
      if (!parsed.success) throw new ConnectorError({ kind: "invalid_input", message: "Invalid write intent" });
      if (parsed.data.action_type !== WRITE_ACTION) {
        throw new ConnectorError({ kind: "unsupported_op", message: `Unsupported action ${parsed.data.action_type}` });
      }
      if (faults.prepareWriteExecutes) externalWrites += 1;
      return {
        lane_id: laneId,
        provider: TEST_PROVIDER,
        connection_id: row.id,
        action_type: WRITE_ACTION,
        target: parsed.data.target,
        payload: parsed.data.changes,
        payload_schema_version: 1,
        expected_before: { status: "Open" },
      };
    };
  }

  function rowFor(conn: { id: string; lane_id: string }): Connection<MockProvider> {
    const row = store.get(conn.id);
    if (!row || row.lane_id !== conn.lane_id) throw notFound();
    return row;
  }

  return {
    connector,
    loader,
    externalWriteCount: () => externalWrites,
    markReconnectRequired: (conn) => {
      rowFor(conn).status = "reconnect_required";
    },
    simulateInvalidGrant: (conn) => {
      const entry = vault.get(vaultKey(conn.lane_id, rowFor(conn).id));
      if (entry) entry.invalidGrant = true;
    },
  };
}

/** Ready-made contract harness for the mock connector. */
export function mockHarness(options: MockConnectorOptions = {}): ContractHarness & { mock: MockSetup } {
  const mock = createMockConnector(options);
  return {
    mock,
    connector: mock.connector,
    loader: mock.loader,
    laneId: "lane-synthetic-a",
    otherLaneId: "lane-synthetic-b",
    connectInput: { kind: "oauth_code", code: MOCK_AUTH_CODE, redirect_uri: "https://portal.example.test/api/oauth/mock/callback" },
    readOps: [{ op: "mock.echo", params: { q: "synthetic" } }, { op: "mock.summary" }],
    writeIntents: [{ action_type: WRITE_ACTION, target: { item_id: "mock-item-1" }, changes: { status: "Done" } }],
    externalWriteCount: mock.externalWriteCount,
    markReconnectRequired: mock.markReconnectRequired,
    simulateInvalidGrant: mock.simulateInvalidGrant,
    secrets: [MOCK_SECRET_CANARY],
  };
}
