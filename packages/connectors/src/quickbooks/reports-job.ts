// QuickBooks report pull (T-052): one connection, the configured summary reports (default: P&L and the two aging summaries), into fin.report_cache. The Inngest function
// (fin.qbo_reports: nightly schedule, concurrency key = connection id, retries) lives in @nichols/core/inngest and calls
// `run`; the wiring over the real stores is in ./index.ts and ../reports/index.ts.
//  - Order: settings and payroll settings are read FIRST (an unreadable one fails the run before any Intuit call: fail
//    closed, D-25); then one Account query to classify payroll accounts; then each report is fetched, projected and stored.
//  - Reports are independent: one failing (shape, basis, store) does not stop the others; the run then fails AFTER the
//    rest were stored. The run is reported retryable if ANY failure was transient. `as_of` is Intuit's own production time
//    (Header.Time), so a retry adds a NEWER row for each report (history, never a changed old row); only the same
//    (report, params, as_of) is replaced. Bounding that history is a retention job (plan-review, Nov 6, 2026 - T-052).
//  - A connection that is not active or degraded is skipped (reconnect_required is never called).
//  - GET only: `QboApi` has no other method. Nothing here writes anywhere but the cache store.
// Counts and report names only in logs and results.
import type { LaneId } from "@nichols/core";
import { ConnectorError, toConnectorError } from "../contract/errors";
import { assertLaneBound, type ConnectionLoader } from "../contract/lane-bound";
import { LaneIdSchema } from "../contract/schemas";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { createJobRunLog } from "../sync/job-run";
import type { SyncRunStore } from "../sync/types";
import type { QboApi } from "./api";
import { assertQuickbooksConnection, type QboConnection } from "./guard";
import { planReports, projectReport, reportPolicy, REPORT_MAX_BYTES, type ProjectedReport, type QboReportKind, type ReportSettings } from "./reports";
import type { JobRunResult } from "../sync/job-run";
import { entityQuery, MAX_PAGES, PAGE_SIZE, type PayrollSettings } from "./sync";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A report older than this at fetch time gets our fetch time as its as_of. */
const MAX_REPORT_AGE_MS = 3_600_000;
const USABLE = new Set(["active", "degraded"]);

export type ReportCacheEntry = {
  report: QboReportKind;
  params: Record<string, string>;
  payload: ProjectedReport["payload"];
  /** The instant the figures were produced (Intuit's Header.Time), never later than `fetchedAt`. */
  asOf: string;
  fetchedAt: string;
};

/** Writes one report to fin.report_cache with the lane's job client. Idempotent on (connection, report, params, as_of). */
export interface ReportCacheStore {
  put(laneId: LaneId, conn: QboConnection, entry: ReportCacheEntry): Promise<void>;
}

export type QboReportsJobDeps = {
  loader: ConnectionLoader<string>;
  api: QboApi;
  store: ReportCacheStore;
  /** `lane_config` report settings (method, period, own-entity classes); a throw fails the run before any call. */
  settings: (laneId: LaneId) => Promise<ReportSettings>;
  /** `lane_config.finance.payroll` (D-25); a throw fails the run before any call. */
  payroll: (laneId: LaneId) => Promise<PayrollSettings>;
  now?: () => number;
  logger?: ConnectorLogger;
  /** Writes one core.sync_runs row (job = reports) per run (T-196). Optional: without it no run is logged. */
  runs?: SyncRunStore;
};

export type QboReportsOutcome =
  | { ok: true; skipped: null; stored: QboReportKind[]; excludedRows: number }
  | { ok: true; skipped: "connection_not_usable" }
  | { ok: false; retryable: boolean; retryAfterSeconds: number | null; errorKind: string; message: string; stored: QboReportKind[] };

export function createQboReportsJob(deps: QboReportsJobDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? connectorLog;
  const runLog = createJobRunLog({ runs: deps.runs, job: "reports", logger: log });

  const failure = (e: ConnectorError, stored: QboReportKind[]): QboReportsOutcome => ({
    ok: false,
    retryable: e.info.disposition === "retry",
    retryAfterSeconds: e.info.retry_after_seconds,
    errorKind: e.info.kind,
    message: e.info.message,
    stored,
  });

  async function accounts(laneId: LaneId, conn: QboConnection): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 0, start = 1; ; page += 1, start += PAGE_SIZE) {
      if (page >= MAX_PAGES) throw new ConnectorError({ kind: "provider_error", message: "Account query did not end" });
      const res = await deps.api.get<{ QueryResponse?: { Account?: unknown } }>(laneId, conn, "/v3/company/{realm}/query", { realm: conn.external_account_id }, { query: entityQuery("Account", start) });
      const rows = res.data?.QueryResponse?.Account;
      if (rows !== undefined && !Array.isArray(rows)) throw new ConnectorError({ kind: "provider_error", message: "Account response is not valid", provider_tid: res.providerTid });
      const items = (rows ?? []) as unknown[];
      out.push(...items);
      if (items.length < PAGE_SIZE) return out;
    }
  }

  return {
    async run(laneId: LaneId, connectionId: string): Promise<QboReportsOutcome> {
      const stored: QboReportKind[] = [];
      let close: ((r: JobRunResult) => Promise<void>) | undefined;
      let error: ConnectorError | undefined;
      let outcome: QboReportsOutcome;
      try {
        if (!LaneIdSchema.safeParse(laneId).success || !UUID.test(connectionId)) throw new ConnectorError({ kind: "invalid_input", message: "A lane and a connection id are required" });
        const loaded = await deps.loader.loadConnection(laneId, connectionId);
        assertLaneBound(laneId, loaded);
        assertQuickbooksConnection(loaded);
        const conn: QboConnection = loaded;
        const child = log.child({ laneId, provider: "quickbooks", connectionId: conn.id });
        if (!USABLE.has(conn.status)) {
          child.info("qbo.reports.skipped", { reason: "connection_not_usable", status: conn.status });
          return { ok: true, skipped: "connection_not_usable" };
        }
        close = await runLog.open(laneId, conn);
        // Fail closed: nothing is fetched until both settings are known.
        const settings = await deps.settings(laneId);
        const payroll = await deps.payroll(laneId);
        const startedMs = now();
        // Fail closed (security final H1): a person on `excluded_entity_ids` is paid through ordinary expense accounts, and a
        // P&L / BalanceSheet / CashFlow line for such an account would show their pay (alone, or against the ledger total).
        // Until those accounts are listed as payroll accounts, only the aging summaries (which drop the person's rows and
        // withhold the totals) are cached.
        const peopleExcluded = payroll.excludedEntityIds.length > 0;
        const kinds = peopleExcluded ? settings.kinds.filter((k) => k === "ar_aging_summary" || k === "ap_aging_summary") : settings.kinds;
        if (peopleExcluded && kinds.length < settings.kinds.length) child.warn("qbo.reports.kinds_withheld", { reason: "excluded_entities", withheld: settings.kinds.length - kinds.length });
        const requests = planReports({ ...settings, kinds }, conn.features.class_tracking === true, startedMs);
        const policy = reportPolicy(await accounts(laneId, conn), payroll);

        let excludedRows = 0;
        let firstError: ConnectorError | null = null;
        for (const request of requests) {
          try {
            const res = await deps.api.get<unknown>(laneId, conn, request.path, { realm: conn.external_account_id }, request.query);
            const projected = projectReport(request, res.data, policy, res.providerTid);
            if (Buffer.byteLength(JSON.stringify(projected.payload), "utf8") > REPORT_MAX_BYTES) {
              throw new ConnectorError({ kind: "provider_error", message: "Report is too large to cache", provider_tid: res.providerTid });
            }
            const fetchedAt = new Date(now()).toISOString();
            // Intuit's production time when it is plausible: not after our fetch (a provider clock ahead) and not more than an
            // hour before it (a stale or wrong clock); otherwise our own fetch time.
            const age = projected.producedAt === null ? Number.NaN : Date.parse(fetchedAt) - Date.parse(projected.producedAt);
            const asOf = age >= 0 && age <= MAX_REPORT_AGE_MS ? (projected.producedAt as string) : fetchedAt;
            await deps.store.put(laneId, conn, { report: request.kind, params: request.params, payload: projected.payload, asOf, fetchedAt });
            stored.push(request.kind);
            excludedRows += projected.excludedRows;
          } catch (e) {
            const err = toConnectorError(e);
            child.warn("qbo.reports.report_failed", { report: request.kind, kind: err.info.kind });
            // A token or connection problem would repeat for every report: stop at once.
            if (err.info.disposition === "reconnect_required" || err.info.kind === "lane_mismatch" || err.info.kind === "connection_unavailable") throw err;
            // A retryable failure wins over a permanent one: the run is retried (the permanent report just fails again), so
            // the transient one is not left unretried.
            if (!firstError || (firstError.info.disposition !== "retry" && err.info.disposition === "retry")) firstError = err;
          }
        }
        child.info("qbo.reports.done", { stored: stored.length, excluded_rows: excludedRows });
        if (firstError) {
          error = firstError;
          outcome = failure(firstError, stored);
        } else outcome = { ok: true, skipped: null, stored, excludedRows };
      } catch (e) {
        error = toConnectorError(e);
        outcome = failure(error, stored);
      }
      // The run row is closed after the work, whatever happened (never throws).
      if (close) await close(error ? { ok: false, error } : { ok: true, received: stored.length, written: stored.length });
      return outcome;
    },
  };
}

export type QboReportsJob = ReturnType<typeof createQboReportsJob>;
