// Run log and cursor persistence for conn.sync (T-038) over core.sync_runs, core.connections and core.sync_cursor_*.
// The lane router's job client for the lane; database messages are never passed on. Only counts, status and the
// redacted ConnectorErrorInfo are written: no records, no cursors in logs, no tokens.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import { createIndexRpc } from "../google/index-rpc";
import type { JobClientFor } from "../vault/tokens";
import { SYNC_STREAMS, type SyncCursorStore, type SyncRunStore } from "./types";

/** A run still `running` after this long belonged to a crashed worker; the next start cancels it. */
export const STALE_RUN_MS = 30 * 60_000;
const UNIQUE_VIOLATION = "23505";
export const GENERIC_STREAM = "default";

export function createSyncRunStore(clientFor: JobClientFor, now: () => Date = () => new Date()): SyncRunStore {
  async function client(laneId: LaneId) {
    try {
      return await clientFor(laneId);
    } catch {
      throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for sync logging" });
    }
  }
  const unavailable = () => new ConnectorError({ kind: "transient", message: "Sync log unavailable" });

  return {
    async start(laneId, conn, input) {
      assertLaneBound(laneId, conn);
      const db = await client(laneId);
      const at = now();
      const runs = () => db.schema("core").from("sync_runs");
      try {
        const cancel = { status: "cancelled", finished_at: at.toISOString() };
        const job = input.job ?? "sync";
        // Deploy-order tolerance (T-196 security M1): a plain sync neither writes nor filters on `job`, so new code still works against
        // a database that has not run migration 20261117100000 yet (the column default is 'sync'). Stale and own-run cancels of a
        // sync may therefore also close a stale row of another job of the same connection, which is harmless.
        const base = () => {
          const q = runs().update(cancel).eq("lane_id", laneId).eq("connection_id", conn.id);
          return (job === "sync" ? q : q.eq("job", job)).eq("status", "running");
        };
        const stale = await base().lt("started_at", new Date(at.getTime() - STALE_RUN_MS).toISOString());
        if (stale.error) throw stale.error;
        if (input.jobRunId) {
          const own = await base().eq("job_run_id", input.jobRunId);
          if (own.error) throw own.error;
        }
        const inserted = await runs()
          .insert({ lane_id: laneId, connection_id: conn.id, kind: job !== "sync" ? "snapshot" : conn.last_sync_at ? "incremental" : "full", ...(job !== "sync" ? { job } : {}), trigger: input.trigger, started_at: at.toISOString(), job_run_id: input.jobRunId })
          .select("id")
          .single();
        if (inserted.error) {
          if (inserted.error.code === UNIQUE_VIOLATION) return null;
          throw inserted.error;
        }
        return { runId: String((inserted.data as { id: string }).id) };
      } catch {
        throw unavailable();
      }
    },

    async finish(laneId, conn, runId, result) {
      assertLaneBound(laneId, conn);
      const db = await client(laneId);
      try {
        const { data, error } = await db
          .schema("core")
          .from("sync_runs")
          .update({
            status: result.status,
            kind: result.kind,
            finished_at: now().toISOString(),
            records_received: result.received,
            records_written: result.written,
            error: result.status === "failed" ? (result.error ?? null) : null,
          })
          .eq("id", runId)
          .eq("lane_id", laneId)
          .eq("connection_id", conn.id)
          .eq("status", "running")
          .select("id");
        if (error) throw error;
        // Zero rows: a later start cancelled this run (stale, or taken over). The caller logs it; nothing else changes.
        if (!Array.isArray(data) || data.length === 0) throw new Error("run no longer running");
      } catch {
        throw unavailable();
      }
    },

    async fullSyncHistory(laneId, conn) {
      assertLaneBound(laneId, conn);
      const db = await client(laneId);
      try {
        // job = 'sync' is the column default, so this also reads rows written before the column existed (T-196).
        const full = () => db.schema("core").from("sync_runs").select("started_at").eq("lane_id", laneId).eq("connection_id", conn.id).eq("job", "sync").eq("kind", "full");
        const [done, last] = await Promise.all([full().eq("status", "succeeded").limit(1), full().order("started_at", { ascending: false }).limit(1)]);
        if (done.error) throw done.error;
        if (last.error) throw last.error;
        const at = Array.isArray(last.data) ? (last.data[0] as { started_at?: unknown } | undefined)?.started_at : undefined;
        return { completed: Array.isArray(done.data) && done.data.length > 0, lastAttemptAt: typeof at === "string" ? at : null };
      } catch {
        throw unavailable();
      }
    },

    async recordOutcome(laneId, conn, outcome, stream = null) {
      assertLaneBound(laneId, conn);
      // The stream ends up in a PostgREST filter below: only the known values, whatever the caller's types say.
      if (stream !== null && !(SYNC_STREAMS as readonly string[]).includes(stream)) throw unavailable();
      const db = await client(laneId);
      const table = () => db.schema("core").from("connections");
      try {
        if (!outcome.ok) {
          const { error } = await table().update({ last_error: outcome.error, last_error_stream: stream }).eq("lane_id", laneId).eq("id", conn.id);
          if (error) throw error;
        } else if (stream === null) {
          const { error } = await table().update({ last_sync_at: now().toISOString(), last_error: null }).eq("lane_id", laneId).eq("id", conn.id);
          if (error) throw error;
        } else {
          // One stream succeeded: the other stream's error must stay (it is still failing until its own tick succeeds).
          const at = await table().update({ last_sync_at: now().toISOString() }).eq("lane_id", laneId).eq("id", conn.id);
          if (at.error) throw at.error;
          const cleared = await table().update({ last_error: null }).eq("lane_id", laneId).eq("id", conn.id).or(`last_error_stream.is.null,last_error_stream.eq.${stream}`);
          if (cleared.error) throw cleared.error;
        }
      } catch {
        throw unavailable();
      }
    },
  };
}

export function createSyncCursorStore(clientFor: JobClientFor): SyncCursorStore {
  const call = createIndexRpc(clientFor, "Sync");
  return {
    async get(laneId, conn) {
      assertLaneBound(laneId, conn);
      const data = await call(laneId, "sync_cursor_get", { p_lane: laneId, p_connection_id: conn.id, p_stream: GENERIC_STREAM });
      return typeof data === "string" && data.length > 0 ? data : null;
    },
    async put(laneId, conn, expected, next) {
      assertLaneBound(laneId, conn);
      const data = await call(laneId, "sync_cursor_put", { p_lane: laneId, p_connection_id: conn.id, p_stream: GENERIC_STREAM, p_expected: expected, p_cursor: next });
      return data === true;
    },
    async reset(laneId, conn) {
      assertLaneBound(laneId, conn);
      // core.sync_cursor_reset: service_role only, lane-checked; deletes this connection's generic stream only.
      await call(laneId, "sync_cursor_reset", { p_lane: laneId, p_connection_id: conn.id, p_stream: GENERIC_STREAM });
    },
  };
}
