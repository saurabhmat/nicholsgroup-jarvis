import type { LaneId } from "@nichols/core";
import type {
  ConnectInput,
  Connection,
  HealthStatus,
  ProposedPayload,
  Provider,
  RawRecord,
  ReadOp,
  SourceResult,
  Subscription,
  SyncCursor,
  SyncSummary,
  WriteIntent,
} from "./schemas";

/** Static description of what a connector implements. Must agree with which optional methods exist (kit-checked). */
export interface ConnectorCapabilities {
  readonly sync: boolean;
  readonly subscribe: boolean;
  readonly prepareWrite: boolean;
  readonly disconnect: boolean;
}

/**
 * One contract for every provider (architecture §6 M2).
 *
 * Rules every implementation follows (enforced by the contract kit in `@nichols/connectors/testing`):
 * - Every method takes `laneId` first and refuses a connection from another lane (`lane_mismatch`).
 * - `read`, `sync`, `subscribe`, `prepareWrite` refuse connections that are not `active`/`degraded`;
 *   `reconnect_required` throws a never-retry error.
 * - Errors cross the boundary only as `ConnectorError`; outputs and errors never contain tokens or secrets.
 * - Tokens are read from the Vault inside the connector (T-033); they are never parameters or return values.
 *
 * There is deliberately **no `executeWrite`** here: external writes go only through the approvals module (rule 5),
 * which uses `ConnectorWriter` from `@nichols/connectors/writer` (T-193 brands the action and lint-restricts the import).
 * Read-only connectors (e.g. QuickBooks, Stripe) simply omit `prepareWrite`.
 */
export interface Connector {
  readonly provider: Provider;
  readonly capabilities: ConnectorCapabilities;
  /** Read ops accepted by `read`; anything else is rejected with `unsupported_op`. */
  readonly readOps: readonly string[];
  /** Feature flags this connector may detect on a connection (e.g. `class_tracking`). */
  readonly featureKeys: readonly string[];

  /** Exchange the in-app OAuth result for a stored connection in `laneId` (tokens go straight to the Vault). */
  connect(laneId: LaneId, input: ConnectInput): Promise<Connection>;

  /** Check the connection and re-detect features. Works on any status; reports problems, does not throw for them. */
  health(laneId: LaneId, conn: Connection): Promise<HealthStatus>;

  /** Live retrieval. */
  read<T = unknown>(laneId: LaneId, conn: Connection, op: ReadOp): Promise<SourceResult<T>>;

  /**
   * Metadata/finance sync. Yields raw records; the generator's return value carries the next cursor, which the caller
   * persists only after the whole run succeeded. `cursor: null` means a full load.
   */
  sync?(laneId: LaneId, conn: Connection, cursor: SyncCursor | null): AsyncGenerator<RawRecord, SyncSummary, void>;

  /** Register or renew a webhook / push subscription. */
  subscribe?(laneId: LaneId, conn: Connection): Promise<Subscription>;

  /** Build the exact payload for a proposal. Never executes anything against the provider. */
  prepareWrite?(laneId: LaneId, conn: Connection, intent: WriteIntent): Promise<ProposedPayload>;

  /** Revoke at the provider and delete stored tokens (QB-8). Returns the connection with status `disconnected`. */
  disconnect?(laneId: LaneId, conn: Connection): Promise<Connection>;
}
