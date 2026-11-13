// Export of the connector error log for the provider's support (Intuit) (T-196, QB-15). GET /api/lanes/PKG/connector-errors/export
// ?from=2026-11-01&to=2026-11-12&format=csv|json[&dataset=errors|runs].
//  - Who: owner or admin_technical of the lane at AAL2 (the same guard as connecting). No session 401; AAL1 or another role 403;
//    a lane that is not the caller's (or no such lane) 404, the same answer as an unknown lane.
//  - What: the lane's core.connector_api_errors (default) or core.sync_runs rows in [from, to), at most 90 days, read with the
//    signed-in user's client, so the database's row-level security is the second guard (another lane's rows can never come back).
//    Date-only from/to are America/New_York days (business time zone); a timestamp must carry Z or an offset.
//    Columns are fixed (never `select *`); the sync-run error message is not exported. Rows are capped; over the cap is 413.
//  - Audit: `connector_errors.export` with who, lane, range, format, dataset and row count, written BEFORE the file leaves; if the
//    audit write fails nothing is returned (503). A request with Sec-Fetch-Site other than same-origin/none is 403.
//  - CSV is formula-injection safe (a cell starting with = + - @ gets a leading apostrophe).
import { AuthError, authErrorResponse, type Guards } from "@nichols/core/auth";
import type { Audit } from "@nichols/core/audit";
import {
  ERROR_COLUMNS, EXPORT_DATASETS, EXPORT_FORMATS, flattenRun, parseExportRange, pick, RUN_COLUMNS, toCsv,
  type ExportDataset, type ExportFormat,
} from "@nichols/connectors/error-log";
import { CONNECT_ROLES } from "@nichols/connectors/oauth";

/** Rows per request to the database and the most one export returns. */
const PAGE = 1000;
export const EXPORT_MAX_ROWS = 10_000;

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status: number) => Response.json(body, { status, headers: NO_STORE });

const RUN_SELECT = "id, started_at, finished_at, connection_id, job, kind, trigger, status, records_received, records_written, error";
const ERROR_SELECT = `id, ${ERROR_COLUMNS.join(", ")}`;

type Row = Record<string, unknown>;
type Page = { data: Row[] | null; error: unknown };
/**
 * One page: the lane's rows in [from, to) with `id` greater than `afterId`, ordered by `id`, at most `limit`. Keyset paging on the
 * unique id: rows with equal timestamps cannot be skipped or repeated across a page boundary, and no precision is lost in a
 * timestamp round trip. The export sorts by time afterwards (the cap keeps that small).
 */
type PageQuery = (table: "connector_api_errors" | "sync_runs", columns: string, timeColumn: string, laneId: string, from: string, to: string, afterId: string | null, limit: number) => Promise<Page>;

export type ExportHandlerDeps = {
  guards: () => Promise<Pick<Guards, "requireLane" | "requireRole">>;
  audit: () => Audit;
  /** Defaults to a query over the signed-in user's lane client; tests inject their own. */
  pageQuery?: (client: unknown) => PageQuery;
  now?: () => Date;
};

interface Q {
  eq(col: string, v: string): Q;
  gte(col: string, v: string): Q;
  lt(col: string, v: string): Q;
  gt(col: string, v: string): Q;
  order(col: string, o: { ascending: boolean }): Q;
  limit(n: number): PromiseLike<Page>;
}
type LaneQueryClient = { schema(s: "core"): { from(t: string): { select(c: string): Q } } };

const userQuery = (client: unknown): PageQuery => async (table, columns, timeColumn, laneId, from, to, afterId, limit) => {
  let q = (client as LaneQueryClient).schema("core").from(table).select(columns).eq("lane_id", laneId).gte(timeColumn, from).lt(timeColumn, to);
  if (afterId !== null) q = q.gt("id", afterId);
  return q.order("id", { ascending: true }).limit(limit);
};

const oneOf = <T extends string>(list: readonly T[], value: string | null, fallback: T): T | null => (value === null ? fallback : (list as readonly string[]).includes(value) ? (value as T) : null);

export function createConnectorErrorExportHandler(deps: ExportHandlerDeps) {
  return async function GET(request: Request, laneId: string): Promise<Response> {
    // A GET that writes an audit row: refuse a cross-site request (browsers send Sec-Fetch-Site; other clients omit it).
    const site = request.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin" && site !== "none") return json({ error: "forbidden" }, 403);
    try {
      const g = await deps.guards();
      try {
        await g.requireLane(laneId);
      } catch (e) {
        if (e instanceof AuthError && e.reason === "forbidden") return json({ error: "not_found" }, 404);
        throw e;
      }
      const { session, client } = await g.requireRole(laneId, CONNECT_ROLES);

      const q = new URL(request.url).searchParams;
      const format = oneOf<ExportFormat>(EXPORT_FORMATS, q.get("format"), "csv");
      const dataset = oneOf<ExportDataset>(EXPORT_DATASETS, q.get("dataset"), "errors");
      if (format === null || dataset === null) return json({ error: "invalid_request" }, 400);
      const range = parseExportRange(q.get("from"), q.get("to"));
      if (!range.ok) return json({ error: range.reason }, 400);

      const query = (deps.pageQuery ?? userQuery)(client);
      const table = dataset === "errors" ? "connector_api_errors" : "sync_runs";
      const columns = dataset === "errors" ? ERROR_SELECT : RUN_SELECT;
      const timeColumn = dataset === "errors" ? "at" : "started_at";
      const rows: Row[] = [];
      // Stop only on an EMPTY page: a server that caps a response below PAGE (PostgREST max_rows) must not cut the file short.
      for (let afterId: string | null = null; ; ) {
        const { data, error } = await query(table, columns, timeColumn, laneId, range.range.from, range.range.to, afterId, PAGE);
        if (error || !Array.isArray(data)) throw new Error("export read failed");
        if (data.length === 0) break;
        const last = data[data.length - 1]?.id;
        if (typeof last !== "string" || (afterId !== null && last <= afterId)) throw new Error("export read failed"); // no progress
        afterId = last;
        rows.push(...data);
        if (rows.length > EXPORT_MAX_ROWS) return json({ error: "too_many_rows", message: "Too many rows for one export. Narrow the date range and try again." }, 413);
      }
      rows.sort((x, y) => String(x[timeColumn]).localeCompare(String(y[timeColumn])) || String(x.id).localeCompare(String(y.id)));

      // Audit first: an export nobody can see in the log never leaves. Ids and counts only, no row content.
      await deps.audit().log({
        laneId: laneId as never,
        actor: { kind: "user", userId: session.userId },
        action: "connector_errors.export",
        target: `lane:${laneId}`,
        metadata: { from: range.range.from, to: range.range.to, format, dataset, rows: rows.length },
      });

      const exported = dataset === "errors" ? pick(rows, ERROR_COLUMNS) : pick(rows.map(flattenRun), RUN_COLUMNS);
      const stamp = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
      const name = `${dataset === "errors" ? "connector-errors" : "sync-runs"}-${laneId}-${stamp}.${format}`;
      const headers = { ...NO_STORE, "x-content-type-options": "nosniff", "content-disposition": `attachment; filename="${name}"` };
      if (format === "json") {
        return new Response(JSON.stringify({ lane: laneId, dataset, from: range.range.from, to: range.range.to, rows: exported }), { status: 200, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
      }
      return new Response(`\uFEFF${toCsv(dataset === "errors" ? ERROR_COLUMNS : RUN_COLUMNS, exported)}`, { status: 200, headers: { ...headers, "content-type": "text/csv; charset=utf-8" } });
    } catch (e) {
      const res = authErrorResponse(e);
      if (res) return res;
      console.error("[api/connector-errors/export] unavailable:", e instanceof Error ? e.name : typeof e);
      return json({ error: "unavailable" }, 503);
    }
  };
}

export { connectorErrorExportUrl } from "./connector-error-export-url";
