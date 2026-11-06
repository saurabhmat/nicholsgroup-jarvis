// The fin.report_cache writer (T-052) over core.fin_report_cache_put with the lane's job client. PostgREST exposes core,
// not fin, and the function re-checks lane, provider and connection status itself. Database messages are never passed on
// (a refusal can name table data): every failure becomes a fixed ConnectorError. The report is not logged.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import type { JobClientFor } from "../vault/tokens";
import { assertQuickbooksConnection } from "./guard";
import type { ReportCacheStore } from "./reports-job";

/** The report write is abandoned after this long (the run then fails as transient and is retried). */
export const REPORT_STORE_TIMEOUT_MS = 30_000;

export function createReportCacheStore(clientFor: JobClientFor): ReportCacheStore {
  return {
    async put(laneId: LaneId, conn, entry) {
      assertLaneBound(laneId, conn);
      assertQuickbooksConnection(conn);
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for report storage" });
      }
      let code: string | undefined;
      try {
        // Client-side bound on the call (a role-wide statement_timeout is not set, see plan-review T-052).
        const { error } = await client.schema("core").rpc("fin_report_cache_put", {
          p_lane: laneId,
          p_connection_id: conn.id,
          p_report: entry.report,
          p_params: entry.params,
          p_payload: entry.payload as never,
          p_as_of: entry.asOf,
          p_fetched_at: entry.fetchedAt,
        }).abortSignal(AbortSignal.timeout(REPORT_STORE_TIMEOUT_MS));
        if (!error) return;
        code = error.code;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Report store unavailable" });
      }
      // 22023 / 23514: the database refused the content (value guard, depth, size, allowlist): a fixed message, never retried.
      if (code === "22023" || code === "23514") throw new ConnectorError({ kind: "provider_error", message: "The report was refused by the report cache" });
      if (code === "42501") throw new ConnectorError({ kind: "connection_unavailable", message: "The connection is not usable for report storage" });
      throw new ConnectorError({ kind: "transient", message: "Report store unavailable" });
    },
  };
}
