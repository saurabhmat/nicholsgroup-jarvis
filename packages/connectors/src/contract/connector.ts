import type { LaneId } from "@nichols/core";
import type { LaneBoundConnection } from "./lane-bound";
import type {
  ConnectInput,
  HealthStatus,
  ProposedPayload,
  Provider,
  RawRecord,
  ReadOp,
  SourceResult,
  Subscription,
  SyncCursor,
  SyncOptions,
  SyncSummary,
  WriteIntent,
} from "./schemas";

/** Static description of which optional methods a connector implements (kit-checked against the methods). */
export interface ConnectorCapabilities {
  readonly sync: boolean;
  readonly subscribe: boolean;
  readonly prepareWrite: boolean;
}

/** Receives sync records in batches; the connector awaits it before fetching more. A throw aborts the run. */
export type SyncSink<P extends string = Provider> = (batch: RawRecord<P>[]) => Promise<void>;

/** Every key a connector object may carry; anything else that is a function fails the contract kit. */
export const CONNECTOR_KEYS = [
  "provider",
  "capabilities",
  "readOps",
  "featureKeys",
  "connect",
  "health",
  "read",
  "sync",
  "subscribe",
  "prepareWrite",
  "disconnect",
] as const;

/**
 * One contract for every provider (architecture §6 M2).
 *
 * Rules every implementation follows (enforced by the contract kit in `@nichols/connectors/testing`):
 * - Every method takes `laneId` first, then a `LaneBoundConnection` minted by a `ConnectionLoader`. The connector calls
 *   `assertLaneBound(laneId, conn)` and then re-reads the authoritative row (lane, status) by `(laneId, conn.id)`;
 *   the caller's object is never trusted for status.
 * - Tokens: read inside the connector via T-033's `getToken`, keyed by `(laneId, connectionId)`, which checks
 *   `core.connections.lane_id = laneId` before reading the Vault. Tokens are never parameters or return values.
 * - `read`, `sync`, `subscribe`, `prepareWrite` refuse connections that are not `active`/`degraded`;
 *   `reconnect_required` throws a never-retry error. `health` reports problems without throwing for them.
 * - Errors cross the boundary only as `ConnectorError` (use `toConnectorError` for anything caught); outputs and
 *   errors never contain tokens or secrets.
 *
 * There is deliberately **no `executeWrite`** here: external writes go only through the approvals module (rule 5),
 * which uses `ConnectorWriter` from `@nichols/connectors/writer` (T-193 brands the action and lint-restricts the import).
 * Read-only connectors (e.g. QuickBooks, Stripe) simply omit `prepareWrite`.
 */
export interface Connector<P extends string = Provider> {
  readonly provider: P;
  readonly capabilities: ConnectorCapabilities;
  /** Read ops accepted by `read`; anything else is rejected with `unsupported_op`. */
  readonly readOps: readonly string[];
  /** Feature flags this connector may detect on a connection (e.g. `class_tracking`). */
  readonly featureKeys: readonly string[];

  /**
   * Store a connection in `laneId` from the in-app OAuth result or a Vault secret reference; tokens go straight to the
   * Vault. With `reconnect_connection_id`, the existing row must be in the same lane, provider and account.
   */
  connect(laneId: LaneId, input: ConnectInput): Promise<LaneBoundConnection<P>>;

  /** Check the connection and re-detect features. Works on any status; reports problems, does not throw for them. */
  health(laneId: LaneId, conn: LaneBoundConnection<P>): Promise<HealthStatus>;

  /** Live retrieval. */
  read<T = unknown>(laneId: LaneId, conn: LaneBoundConnection<P>, op: ReadOp): Promise<SourceResult<T, P>>;

  /**
   * Metadata/finance sync. Hands records to `sink` in batches and resolves with the next cursor once the whole run
   * succeeded; the caller persists the cursor only then. `cursor: null` means a full load.
   */
  sync?(
    laneId: LaneId,
    conn: LaneBoundConnection<P>,
    cursor: SyncCursor | null,
    sink: SyncSink<P>,
    options?: SyncOptions,
  ): Promise<SyncSummary>;

  /** Register or renew a webhook / push subscription. */
  subscribe?(laneId: LaneId, conn: LaneBoundConnection<P>): Promise<Subscription<P>>;

  /** Build the exact payload for a proposal. Never executes anything against the provider. */
  prepareWrite?(laneId: LaneId, conn: LaneBoundConnection<P>, intent: WriteIntent): Promise<ProposedPayload<P>>;

  /** Revoke at the provider, delete the Vault secret (QB-8) and return the connection as `disconnected`. */
  disconnect(laneId: LaneId, conn: LaneBoundConnection<P>): Promise<LaneBoundConnection<P>>;
}
