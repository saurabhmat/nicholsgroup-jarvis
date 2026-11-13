// conn.sync (T-038): the shapes shared by the job, the run log, the cursor store and the provider runners.
import type { LaneId } from "@nichols/core";
import type { LaneBoundConnection } from "../contract/lane-bound";
import type { ConnectorErrorInfo } from "../contract/schemas";

export const SYNC_TRIGGERS = ["schedule", "manual", "webhook", "connect"] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

/** Streams a Google run can be limited to (T-238). Absent = both. */
export const SYNC_STREAMS = ["mail", "calendar"] as const;
export type SyncStream = (typeof SYNC_STREAMS)[number];

/** Which job wrote a core.sync_runs row (T-196): conn.sync (any trigger, webhook CDC included), the report pull, the normalizer. */
export const SYNC_JOBS = ["sync", "reports", "normalize"] as const;
export type SyncJob = (typeof SYNC_JOBS)[number];

/** What one provider runner reports after a run. Counts only: never a record, never a cursor. */
export type SyncRunnerResult = { kind: "full" | "incremental"; received: number; written: number };

/** Runs one connection's sync. Throws ConnectorError for failures (anything else is reduced to a generic provider_error). */
export type SyncRunner = (laneId: LaneId, conn: LaneBoundConnection<string>, options?: { objectTypes?: readonly string[]; streams?: readonly SyncStream[] }) => Promise<SyncRunnerResult>;

export type SyncRunFinish = {
  status: "succeeded" | "failed" | "cancelled";
  /** `snapshot` for the report pull and the normalizer (no cursor); full / incremental for a sync. */
  kind: "full" | "incremental" | "snapshot";
  received: number;
  written: number;
  /** Required for `failed`, forbidden otherwise (database check). Already redacted by ConnectorError. */
  error?: ConnectorErrorInfo;
};

/** `core.sync_runs` and the connection's last-sync fields, through the lane's job client. */
export interface SyncRunStore {
  /**
   * Starts a run row (`running`). Before inserting, ends a run of the same connection that this Inngest run left open
   * (an earlier attempt) or that has been running longer than the stale limit (a crashed worker): both become
   * `cancelled`. Returns null when another run is genuinely running (the database allows one per connection).
   */
  start(laneId: LaneId, conn: LaneBoundConnection<string>, input: { trigger: SyncTrigger; jobRunId: string | null; job?: SyncJob }): Promise<{ runId: string } | null>;
  finish(laneId: LaneId, conn: LaneBoundConnection<string>, runId: string, result: SyncRunFinish): Promise<void>;
  /**
   * Success: last_sync_at = now, last_error cleared. Failure: last_error = the redacted error (status is not changed here).
   * T-238: `stream` is set when the run synced ONE stream (mail or calendar): a failure is tagged with it (last_error_stream),
   * and a success clears last_error only when it belongs to that stream or to the whole connection (another stream's error stays).
   */
  recordOutcome(laneId: LaneId, conn: LaneBoundConnection<string>, outcome: { ok: true } | { ok: false; error: ConnectorErrorInfo }, stream?: SyncStream | null): Promise<void>;
}

/** Cursor of the generic stream (`Connector.sync`), stored in core.sync_cursors. Mail and calendar keep their own streams. */
export interface SyncCursorStore {
  get(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<string | null>;
  /** Compare-and-swap: stores `next` only if the stored cursor is still `expected`. False = another run advanced it first. */
  put(laneId: LaneId, conn: LaneBoundConnection<string>, expected: string | null, next: string): Promise<boolean>;
}

/** The run is not retried by Inngest unless `retryable`; `retryAfterSeconds` is the provider's hint for rate limits. */
export type ConnSyncOutcome =
  | { ok: true; skipped: null; runId: string; provider: string; kind: "full" | "incremental"; received: number; written: number }
  | { ok: true; skipped: "already_running" | "connection_not_usable" }
  | { ok: false; retryable: boolean; retryAfterSeconds: number | null; errorKind: string; message: string };
