// Run logging for the QuickBooks jobs that are not conn.sync (T-196): the report pull (fin.qbo_reports) and the normalizer
// (fin.qbo_normalize) each write one core.sync_runs row per connection (job = reports | normalize, kind = snapshot): start, end,
// status, counts and the redacted error. conn.sync, including the webhook-triggered CDC (trigger 'webhook'), writes its own
// (./job.ts). Counts and a ConnectorErrorInfo only; no content.
//
// Best effort, by design: the job's work is idempotent and its outcome stands whatever the log does. A run that cannot be started
// (database down) or is already open (another run of the same job) is logged by code and the work goes ahead without a row; a row that
// cannot be closed is logged by code and left for the next start, which cancels a stale one. Nothing here throws.
import type { LaneId } from "@nichols/core";
import type { ConnectorError } from "../contract/errors";
import type { LaneBoundConnection } from "../contract/lane-bound";
import type { ConnectorLogger } from "../log/index";
import type { SyncJob, SyncRunStore, SyncTrigger } from "./types";

export type JobRunResult = { ok: true; received: number; written: number } | { ok: false; error: ConnectorError; received?: number; written?: number };

export interface JobRunLog {
  /** Starts the row; returns a closer. Always returns one (a no-op when nothing was started). */
  open(laneId: LaneId, conn: LaneBoundConnection<string>, trigger?: SyncTrigger): Promise<(result: JobRunResult) => Promise<void>>;
}

export function createJobRunLog(deps: { runs: SyncRunStore | undefined; job: Exclude<SyncJob, "sync">; logger: ConnectorLogger }): JobRunLog {
  const { runs, job } = deps;
  return {
    async open(laneId, conn, trigger = "schedule") {
      const noop = async () => undefined;
      if (!runs) return noop;
      const child = deps.logger.child({ laneId, provider: conn.provider, connectionId: conn.id });
      let started: { runId: string } | null = null;
      try {
        started = await runs.start(laneId, conn, { trigger, jobRunId: null, job });
      } catch {
        child.error(`${job}.run_log_failed`, { code: "start_failed" });
        return noop;
      }
      if (!started) {
        child.info(`${job}.run_log_skipped`, { reason: "already_running" });
        return noop;
      }
      const runId = started.runId;
      return async (result) => {
        try {
          await runs.finish(
            laneId,
            conn,
            runId,
            result.ok
              ? { status: "succeeded", kind: "snapshot", received: result.received, written: result.written }
              : { status: "failed", kind: "snapshot", received: result.received ?? 0, written: result.written ?? 0, error: result.error.toJSON() },
          );
        } catch {
          child.error(`${job}.run_log_failed`, { code: "finish_failed" });
        }
      };
    },
  };
}
