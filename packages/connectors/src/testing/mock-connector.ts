// In-memory mock connector with synthetic data only. Passes the contract kit; used by the kit's own tests and by later
// job tests (T-038 conn.sync, T-113 counting executor). It never makes network calls.
import { randomUUID } from "node:crypto";
import type { LaneId } from "@nichols/core";
import type { Connector, ConnectorCapabilities } from "../contract/connector";
import { ConnectorError } from "../contract/errors";
import { assertConnectionInLane, assertConnectionUsable } from "../contract/guards";
import {
  ConnectInputSchema,
  LaneIdSchema,
  ReadOpSchema,
  SyncCursorSchema,
  WriteIntentSchema,
  type Connection,
  type HealthStatus,
  type ProposedPayload,
  type RawRecord,
  type SourceResult,
  type Subscription,
  type SyncCursor,
  type SyncSummary,
} from "../contract/schemas";
import type { ContractHarness } from "./contract-kit";

/** Synthetic authorization code the mock accepts. */
export const MOCK_AUTH_CODE = "synthetic-auth-code";
/** Synthetic token the mock "stores in the Vault". The contract kit fails if it ever appears in an output. */
export const MOCK_SECRET_CANARY = "canary-token-0f3c9a7e-not-a-real-secret";

const READ_OPS = ["mock.echo", "mock.summary"] as const;
const FEATURE_KEYS = ["class_tracking", "multicurrency"] as const;
const WRITE_ACTION = "mock.item.update";
const BASE_TIME = Date.parse("2026-10-01T00:00:00.000Z");

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
  /** Deliberately broken: `prepareWrite` counts as an external write. Only for proving the kit catches it. */
  prepareWriteExecutes?: boolean;
}

export interface MockConnector extends Connector {
  /** Number of writes made against the (pretend) provider. */
  externalWriteCount(): number;
}

export function createMockConnector(options: MockConnectorOptions = {}): MockConnector {
  const now = options.now ?? (() => new Date());
  const recordCount = options.recordCount ?? 3;
  const vault = new Map<string, string>(); // connection id -> synthetic token
  let externalWrites = 0;
  let tid = 0;
  const nextTid = () => `mock-tid-${++tid}`;

  const hasSync = options.sync ?? true;
  const hasSubscribe = options.subscribe ?? true;
  const hasPrepareWrite = !(options.readOnly ?? false);

  const capabilities: ConnectorCapabilities = {
    sync: hasSync,
    subscribe: hasSubscribe,
    prepareWrite: hasPrepareWrite,
    disconnect: true,
  };

  const connector: MockConnector = {
    provider: "mock",
    capabilities,
    readOps: READ_OPS,
    featureKeys: FEATURE_KEYS,

    externalWriteCount: () => externalWrites,

    async connect(laneId: LaneId, input): Promise<Connection> {
      if (!LaneIdSchema.safeParse(laneId).success) {
        throw new ConnectorError({ kind: "invalid_input", message: "laneId is required" });
      }
      const parsed = ConnectInputSchema.safeParse(input);
      if (!parsed.success) throw new ConnectorError({ kind: "invalid_input", message: "Invalid connect input" });
      if (parsed.data.code !== MOCK_AUTH_CODE) {
        throw new ConnectorError({ kind: "forbidden", message: "Authorization code rejected", http_status: 400, provider_tid: nextTid() });
      }
      const id = parsed.data.reconnect_connection_id ?? randomUUID();
      vault.set(id, MOCK_SECRET_CANARY);
      const at = now();
      return {
        id,
        lane_id: laneId,
        provider: "mock",
        external_account_id: parsed.data.external_account_id ?? "mock-account-1",
        status: "active",
        features: { class_tracking: true, multicurrency: false },
        features_checked_at: at.toISOString(),
        token_expires_at: new Date(at.getTime() + 3600_000).toISOString(),
        last_sync_at: null,
        last_error: null,
      };
    },

    async health(laneId, conn): Promise<HealthStatus> {
      assertConnectionInLane(laneId, conn);
      const checked_at = now().toISOString();
      if (conn.status === "reconnect_required" || conn.status === "disconnected" || !vault.has(conn.id)) {
        const error = new ConnectorError({ kind: "reconnect_required", message: "Connection needs to be reconnected" });
        return { ok: false, status: conn.status === "disconnected" ? "disconnected" : "reconnect_required", checked_at, provider_tid: null, error: error.toJSON() };
      }
      return { ok: true, status: "active", checked_at, features: { class_tracking: true, multicurrency: false }, provider_tid: nextTid(), error: null };
    },

    async read<T = unknown>(laneId: LaneId, conn: Connection, op: Parameters<Connector["read"]>[2]): Promise<SourceResult<T>> {
      assertConnectionUsable(laneId, conn);
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
        provider: "mock",
        connection_id: conn.id,
        op: name,
        data: data as T,
        as_of: at,
        fetched_at: at,
        freshness: "live",
        provider_tid: nextTid(),
        source_refs: [{ kind: "mock_object", ref: `${name}:1` }],
        notes: [],
      };
    },

    async disconnect(laneId, conn): Promise<Connection> {
      assertConnectionInLane(laneId, conn);
      vault.delete(conn.id);
      return { ...conn, status: "disconnected", token_expires_at: null };
    },
  };

  if (hasSync) {
    connector.sync = async function* (laneId: LaneId, conn: Connection, cursor: SyncCursor | null): AsyncGenerator<RawRecord, SyncSummary, void> {
      assertConnectionUsable(laneId, conn);
      let since = Number.NEGATIVE_INFINITY;
      if (cursor !== null) {
        const parsedCursor = SyncCursorSchema.safeParse(cursor);
        since = parsedCursor.success ? Date.parse(parsedCursor.data.value) : Number.NaN;
        if (Number.isNaN(since)) throw new ConnectorError({ kind: "invalid_input", message: "Invalid sync cursor" });
      }
      const syncedAt = now().toISOString();
      let latest = cursor === null ? BASE_TIME : since;
      let yielded = 0;
      for (let i = 1; i <= recordCount; i += 1) {
        const updated = BASE_TIME + i * 60_000;
        if (updated <= since) continue;
        latest = Math.max(latest, updated);
        yielded += 1;
        yield {
          lane_id: laneId,
          provider: "mock",
          connection_id: conn.id,
          object_type: "MockItem",
          external_id: `mock-item-${i}`,
          payload: { id: `mock-item-${i}`, name: `Synthetic item ${i}`, amount: "10.00" },
          source_updated_at: new Date(updated).toISOString(),
          deleted: false,
          synced_at: syncedAt,
        };
      }
      return { cursor: { value: new Date(latest).toISOString() }, mode: cursor === null ? "full" : "incremental", records: yielded, provider_tid: nextTid() };
    };
  }

  if (hasSubscribe) {
    connector.subscribe = async (laneId, conn): Promise<Subscription> => {
      assertConnectionUsable(laneId, conn);
      const at = now();
      return {
        id: `mock-sub-${conn.id}`,
        lane_id: laneId,
        provider: "mock",
        connection_id: conn.id,
        kind: "webhook",
        expires_at: new Date(at.getTime() + 7 * 86400_000).toISOString(),
        created_at: at.toISOString(),
      };
    };
  }

  if (hasPrepareWrite) {
    connector.prepareWrite = async (laneId, conn, intent): Promise<ProposedPayload> => {
      assertConnectionUsable(laneId, conn);
      const parsed = WriteIntentSchema.safeParse(intent);
      if (!parsed.success) throw new ConnectorError({ kind: "invalid_input", message: "Invalid write intent" });
      if (parsed.data.action_type !== WRITE_ACTION) {
        throw new ConnectorError({ kind: "unsupported_op", message: `Unsupported action ${parsed.data.action_type}` });
      }
      if (options.prepareWriteExecutes) externalWrites += 1;
      return {
        lane_id: laneId,
        provider: "mock",
        connection_id: conn.id,
        action_type: WRITE_ACTION,
        target: parsed.data.target,
        payload: parsed.data.changes,
        payload_schema_version: 1,
        expected_before: { status: "Open" },
      };
    };
  }

  return connector;
}

/** Ready-made contract harness for the mock connector. */
export function mockHarness(options: MockConnectorOptions = {}): ContractHarness {
  const connector = createMockConnector(options);
  return {
    connector,
    laneId: "lane-synthetic-a",
    otherLaneId: "lane-synthetic-b",
    connectInput: { kind: "oauth_code", code: MOCK_AUTH_CODE, redirect_uri: "https://portal.example.test/api/oauth/mock/callback" },
    readOps: [{ op: "mock.echo", params: { q: "synthetic" } }, { op: "mock.summary" }],
    writeIntents: [{ action_type: WRITE_ACTION, target: { item_id: "mock-item-1" }, changes: { status: "Done" } }],
    externalWriteCount: () => connector.externalWriteCount(),
    secrets: [MOCK_SECRET_CANARY],
  };
}
