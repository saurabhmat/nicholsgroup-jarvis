// QuickBooks normalizer job (T-056): raw.source_records -> fin.* for one connection, after a successful sync. The Inngest
// function (fin.qbo_normalize: concurrency key = connection id, retries) lives in @nichols/core/inngest and calls `run`;
// the wiring over the real stores is in ./index.ts and ../normalize/index.ts.
//  - All the work is one SQL function (figures come from SQL, rule 7; AI never writes here). This job validates the ids,
//    loads the connection lane-bound, skips a connection that is not active/degraded, calls the store, and reports counts.
//  - Idempotent: a repeated or concurrent call finds nothing to change (the database serialises per connection).
//  - Counts only in logs and results. The class-tracking fallback (QB-10) is logged as a warning when it was used.
import type { LaneId } from "@nichols/core";
import { ConnectorError, toConnectorError } from "../contract/errors";
import { assertLaneBound, type ConnectionLoader } from "../contract/lane-bound";
import { LaneIdSchema } from "../contract/schemas";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { createJobRunLog } from "../sync/job-run";
import type { JobRunResult } from "../sync/job-run";
import type { SyncRunStore } from "../sync/types";
import { assertQuickbooksConnection } from "./guard";
import type { NormalizeStore } from "./normalize-store";

const OK = (written: number, tombstoned: number): JobRunResult => ({ ok: true, received: written + tombstoned, written });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USABLE = new Set(["active", "degraded"]);

export type QboNormalizeOutcome =
  | { ok: true; skipped: null; classFallback: boolean; written: number; tombstoned: number; unmappedRows: number; reallocated: number }
  | { ok: true; skipped: "connection_not_usable" }
  | { ok: false; retryable: boolean; retryAfterSeconds: number | null; errorKind: string; message: string };

export type QboNormalizeJobDeps = {
  loader: ConnectionLoader<string>;
  store: NormalizeStore;
  logger?: ConnectorLogger;
  /** Writes one core.sync_runs row (job = normalize) per run (T-196). Optional: without it no run is logged. */
  runs?: SyncRunStore;
};

export function createQboNormalizeJob(deps: QboNormalizeJobDeps) {
  const log = deps.logger ?? connectorLog;
  const runLog = createJobRunLog({ runs: deps.runs, job: "normalize", logger: log });

  const failure = (e: ConnectorError): QboNormalizeOutcome => ({
    ok: false,
    retryable: e.info.disposition === "retry",
    retryAfterSeconds: e.info.retry_after_seconds,
    errorKind: e.info.kind,
    message: e.info.message,
  });

  return {
    async run(laneId: LaneId, connectionId: string): Promise<QboNormalizeOutcome> {
      let close: ((r: JobRunResult) => Promise<void>) | undefined;
      try {
        if (!LaneIdSchema.safeParse(laneId).success || !UUID.test(connectionId)) throw new ConnectorError({ kind: "invalid_input", message: "A lane and a connection id are required" });
        const conn = await deps.loader.loadConnection(laneId, connectionId);
        assertLaneBound(laneId, conn);
        assertQuickbooksConnection(conn);
        const child = log.child({ laneId, provider: "quickbooks", connectionId: conn.id });
        if (!USABLE.has(conn.status)) {
          child.info("qbo.normalize.skipped", { reason: "connection_not_usable", status: conn.status });
          return { ok: true, skipped: "connection_not_usable" };
        }
        close = await runLog.open(laneId, conn);
        const r = await deps.store.normalize(laneId, conn);
        const tables = [r.accounts, r.invoices, r.bills, r.payments, r.transactions];
        const written = tables.reduce((n, t) => n + t.inserted + t.updated, 0);
        const tombstoned = tables.reduce((n, t) => n + t.tombstoned, 0);
        if (r.invalid_records > 0) child.warn("qbo.normalize.invalid_records", { count: r.invalid_records });
        if (r.class_fallback) child.warn("qbo.normalize.class_fallback", { rows: r.class_fallback_rows });
        child.info("qbo.normalize.done", {
          written,
          tombstoned,
          unmapped_rows: r.unmapped_rows,
          invalid_records: r.invalid_records,
          null_account_lines: r.null_account_lines,
          class_fallback: r.class_fallback,
          dead_unseen: r.dead_unseen,
          dead_payroll: r.dead_payroll,
          dead_entity: r.dead_entity,
          dead_linked: r.dead_linked,
          reallocated: r.payments.reallocated,
        });
        await close(OK(written, tombstoned));
        return { ok: true, skipped: null, classFallback: r.class_fallback, written, tombstoned, unmappedRows: r.unmapped_rows, reallocated: r.payments.reallocated };
      } catch (e) {
        const err = toConnectorError(e);
        if (close) await close({ ok: false, error: err });
        log.child(LaneIdSchema.safeParse(laneId).success ? { laneId, provider: "quickbooks" } : { provider: "quickbooks" }).warn("qbo.normalize.failed", { kind: err.info.kind, message: err.info.message });
        return failure(err);
      }
    },
  };
}

export type QboNormalizeJob = ReturnType<typeof createQboNormalizeJob>;
