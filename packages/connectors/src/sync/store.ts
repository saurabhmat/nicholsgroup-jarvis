// Run log and cursor persistence for conn.sync (T-038) over core.sync_runs, core.connections and core.sync_cursor_*.
// The lane router's job client for the lane; database messages are never passed on. Only counts, status and the
// redacted ConnectorErrorInfo are written: no records, no cursors in logs, no tokens.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import { createIndexRpc } from "../google/index-rpc";
import type { JobClientFor } from "../vault/tokens";
import type { SyncCursorStore, SyncRunStore } from "./types";

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
        const base = () => runs().update(cancel).eq("lane_id", laneId).eq("connection_id", conn.id).eq("status", "running");
        const stale = await base().lt("started_at", new Date(at.getTime() - STALE_RUN_MS).toISOString());
        if (stale.error) throw stale.error;
        if (input.jobRunId) {
          const own = await base().eq("job_run_id", input.jobRunId);
          if (own.error) throw own.error;
        }
        const inserted = await runs()
          .insert({ lane_id: laneId, connection_id: conn.id, kind: conn.last_sync_at ? "incremental" : "full", trigger: input.trigger, started_at: at.toISOString(), job_run_id: input.jobRunId })
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

    async recordOutcome(laneId, conn, outcome) {
      assertLaneBound(laneId, conn);
      const db = await client(laneId);
      try {
        const patch = outcome.ok ? { last_sync_at: now().toISOString(), last_error: null } : { last_error: outcome.error };
        const { error } = await db.schema("core").from("connections").update(patch).eq("lane_id", laneId).eq("id", conn.id);
        if (error) throw error;
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
  };
}
