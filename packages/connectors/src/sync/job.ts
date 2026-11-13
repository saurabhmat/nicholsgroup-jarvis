// conn.sync (T-038): one connection's sync, with the run log. Pure orchestration over injected parts, so it is tested
// with a mock provider and an in-memory run store. The Inngest function (concurrency key = connection id, retries)
// lives in @nichols/core/inngest and calls `run`; the wiring over the real stores is in ./index.ts.
//
// Every attempt is one core.sync_runs row: started (running) -> succeeded | failed (redacted error) | cancelled. A
// failing connection returns a failed outcome for that connection only; nothing here touches another connection.
import type { LaneId } from "@nichols/core";
import { ConnectorError, toConnectorError } from "../contract/errors";
import type { ConnectionLoader } from "../contract/lane-bound";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { ConnSyncOutcome, SyncRunStore, SyncRunner, SyncStream, SyncTrigger } from "./types";

const USABLE = new Set(["active", "degraded"]);
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type ConnSyncJobDeps = {
  loader: ConnectionLoader<string>;
  runs: SyncRunStore;
  /** Runner per provider slug. A provider without one fails its runs (unsupported_op), never silently succeeds. */
  runners: Readonly<Record<string, SyncRunner>>;
  logger?: ConnectorLogger;
};

/** T-241: a connection with no completed full sync is promoted to a full load at most once per this window (any outcome). */
export const FULL_RETRY_BACKOFF_MS = 6 * 3_600_000;

export function createConnSyncJob(deps: ConnSyncJobDeps) {
  const log = deps.logger ?? connectorLog;

  const failure = (e: ConnectorError): ConnSyncOutcome => ({
    ok: false,
    retryable: e.info.disposition === "retry",
    retryAfterSeconds: e.info.retry_after_seconds,
    errorKind: e.info.kind,
    message: e.info.message,
  });

  return {
    async run(laneId: LaneId, connectionId: string, input: { trigger: SyncTrigger; jobRunId?: string | null; objectTypes?: readonly string[]; streams?: readonly SyncStream[] }): Promise<ConnSyncOutcome> {
      const jobRunId = input.jobRunId && RUN_ID.test(input.jobRunId) ? input.jobRunId : null;
      let conn;
      try {
        conn = await deps.loader.loadConnection(laneId, connectionId);
      } catch (e) {
        // No connection (or another lane's): nothing to log a run against.
        return failure(toConnectorError(e));
      }
      const child = log.child({ laneId, provider: conn.provider, connectionId: conn.id });
      if (!USABLE.has(conn.status)) {
        child.info("conn.sync.skipped", { reason: "connection_not_usable", status: conn.status });
        return { ok: true, skipped: "connection_not_usable" };
      }

      let started;
      try {
        started = await deps.runs.start(laneId, conn, { trigger: input.trigger, jobRunId });
      } catch (e) {
        return failure(toConnectorError(e));
      }
      if (!started) {
        child.info("conn.sync.skipped", { reason: "already_running" });
        return { ok: true, skipped: "already_running" };
      }

      // T-238: a run of exactly one stream tags its error with that stream (and clears only that stream's error).
      const oneStream = input.streams && new Set(input.streams).size === 1 ? (input.streams[0] ?? null) : null;
      let outcome: ConnSyncOutcome;
      let full = false;
      let error: ConnectorError | null = null;
      let result: Awaited<ReturnType<SyncRunner>> | null = null;
      try {
        const runner = deps.runners[conn.provider];
        if (!runner) throw new ConnectorError({ kind: "unsupported_op", message: "No sync is available for this provider" });
        const hasTypes = input.objectTypes && input.objectTypes.length > 0;
        const hasStreams = input.streams && input.streams.length > 0;
        // T-241: a connect (new or reconnected) always reloads everything; so does a connection whose first full load never
        // completed (a cursor alone does not prove the data is there). Unreadable history keeps the cursor (the CDC window still
        // bounds it) rather than failing the sync.
        // Only runners that honour `full` (the generic cursor runner); Google keeps per-stream cursors and ignores it.
        const reloads = (runner as { reloadsOnFull?: boolean }).reloadsOnFull === true;
        full = reloads && input.trigger === "connect";
        // From the history only for scheduled and manual runs (a webhook stays a cheap targeted fetch), and not again within
        // FULL_RETRY_BACKOFF_MS of the last full attempt, so a load that keeps failing is not repeated on every tick (review M1).
        if (reloads && !full && (input.trigger === "schedule" || input.trigger === "manual") && deps.runs.fullSyncHistory) {
          try {
            const h = await deps.runs.fullSyncHistory(laneId, conn);
            const recent = h.lastAttemptAt !== null && Date.now() - Date.parse(h.lastAttemptAt) < FULL_RETRY_BACKOFF_MS;
            full = !h.completed && !recent;
            if (!h.completed && recent) child.info("conn.sync.full_reload_backoff", {});
          } catch {
            child.warn("conn.sync.full_history_unreadable", {});
          }
        }
        if (full) child.info("conn.sync.full_reload", { reason: input.trigger === "connect" ? "connect" : "no_completed_full_sync" });
        const options = { ...(hasTypes ? { objectTypes: input.objectTypes } : {}), ...(hasStreams ? { streams: input.streams } : {}), ...(full ? { full: true } : {}) };
        result = await runner(laneId, conn, Object.keys(options).length > 0 ? options : undefined);
      } catch (e) {
        error = toConnectorError(e);
      }

      // Best effort: the sync already happened (or failed) and its outcome stands whatever the log does. A log failure
      // never turns a finished sync into a retry (that would repeat the work); a row left open is taken over by the
      // next attempt of the same job run, cancelled below when the failure is permanent, or cancelled when stale.
      const guarded = async (fn: () => Promise<void>, event: string): Promise<boolean> => {
        try {
          await fn();
          return true;
        } catch {
          child.error(event, {});
          return false;
        }
      };
      if (result) {
        const done = result;
        // The connection's last-sync fields follow only a run row that was actually closed by this run (a run cancelled
        // meanwhile as stale must not overwrite the state of the run that replaced it).
        const logged = await guarded(() => deps.runs.finish(laneId, conn, started.runId, { status: "succeeded", kind: done.kind, received: done.received, written: done.written }), "conn.sync.log_failed");
        if (logged) await guarded(() => deps.runs.recordOutcome(laneId, conn, { ok: true }, oneStream), "conn.sync.outcome_failed");
        child.info("conn.sync.succeeded", { kind: done.kind, received: done.received, written: done.written });
        outcome = { ok: true, skipped: null, runId: started.runId, provider: conn.provider, ...done };
      } else {
        const failed = error as ConnectorError;
        const info = failed.toJSON();
        const logged = await guarded(() => deps.runs.finish(laneId, conn, started.runId, { status: "failed", kind: full || !conn.last_sync_at ? "full" : "incremental", received: 0, written: 0, error: info }), "conn.sync.log_failed");
        if (!logged) await guarded(() => deps.runs.finish(laneId, conn, started.runId, { status: "cancelled", kind: full || !conn.last_sync_at ? "full" : "incremental", received: 0, written: 0 }), "conn.sync.log_failed");
        if (logged) await guarded(() => deps.runs.recordOutcome(laneId, conn, { ok: false, error: info }, oneStream), "conn.sync.outcome_failed");
        child.warn("conn.sync.failed", { kind: info.kind, disposition: info.disposition });
        outcome = failure(failed);
      }
      return outcome;
    },
  };
}

export type ConnSyncJob = ReturnType<typeof createConnSyncJob>;
