// T-196: every QuickBooks job logs a core.sync_runs row per connection. conn.sync (initial/CDC/webhook CDC) is covered by job.test.ts
// and store.test.ts; this covers the report pull and the normalizer: start, end, status, counts, redacted error, and that a run-log
// problem never changes or breaks the job.
import { describe, expect, it, vi } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { createQboNormalizeJob } from "../quickbooks/normalize-job";
import type { NormalizeResult } from "../quickbooks/normalize-store";
import { createQboReportsJob } from "../quickbooks/reports-job";
import type { SyncRunFinish, SyncRunStore, SyncJob } from "./types";

const ID = "00000000-0000-4000-8000-0000000000c1";
const mint = (over: Record<string, unknown> = {}) => mintLaneBoundConnection<string>({
  id: ID, lane_id: "PKG", provider: "quickbooks", external_account_id: "9341450000000001", status: "active",
  features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: "2026-11-12T00:00:00.000Z", last_error: null, ...over,
} as never);
const t = { inserted: 2, updated: 1, tombstoned: 1, invalid: 0 };
const RESULT: NormalizeResult = {
  class_tracking: false, class_fallback: false, class_fallback_rows: 0, unmapped_rows: 0, null_account_lines: 0, invalid_records: 0, dead_deleted: 0, dead_unseen: 0, dead_payroll: 0, dead_entity: 0, dead_linked: 0,
  accounts: t, invoices: t, bills: t, payments: { ...t, reallocated: 0 }, transactions: t,
};

function memoryRuns(over: { startThrows?: boolean; startNull?: boolean; finishThrows?: boolean } = {}) {
  const started: { job: SyncJob | undefined; trigger: string }[] = [];
  const finished: SyncRunFinish[] = [];
  const store: SyncRunStore = {
    async start(_l, _c, input) {
      if (over.startThrows) throw new ConnectorError({ kind: "transient", message: "Sync log unavailable" });
      if (over.startNull) return null;
      started.push({ job: input.job, trigger: input.trigger });
      return { runId: "run-1" };
    },
    async finish(_l, _c, _id, r) {
      if (over.finishThrows) throw new ConnectorError({ kind: "transient", message: "Sync log unavailable" });
      finished.push(r);
    },
    async recordOutcome() {
      throw new Error("a non-sync job never touches the connection's last-sync fields");
    },
  };
  return { store, started, finished };
}
const logs = () => {
  const lines: LogEntry[] = [];
  return { lines, logger: createConnectorLogger({ sink: (e) => lines.push(e) }) };
};

describe("normalizer run log", () => {
  const mk = (runs: SyncRunStore | undefined, normalize = async () => RESULT, conn = mint()) => {
    const l = logs();
    return { l, job: createQboNormalizeJob({ loader: { loadConnection: async () => conn } as never, store: { normalize: vi.fn(normalize) }, logger: l.logger, ...(runs ? { runs } : {}) }) };
  };

  it("a successful run: one row, job normalize, kind snapshot, counts", async () => {
    const r = memoryRuns();
    const out = await mk(r.store).job.run("PKG", ID);
    expect(out).toMatchObject({ ok: true, written: 15, tombstoned: 5 });
    expect(r.started).toEqual([{ job: "normalize", trigger: "schedule" }]);
    expect(r.finished).toEqual([{ status: "succeeded", kind: "snapshot", received: 20, written: 15 }]);
  });
  it("the caller's trigger is recorded", async () => {
    const r = memoryRuns();
    await mk(r.store).job.run("PKG", ID, { trigger: "webhook" });
    expect(r.started).toEqual([{ job: "normalize", trigger: "webhook" }]);
  });
  it("a failed run: status failed with the redacted error info, the outcome unchanged", async () => {
    const r = memoryRuns();
    const out = await mk(r.store, async () => { throw new ConnectorError({ kind: "transient", message: "Database busy", http_status: 503 }); }).job.run("PKG", ID);
    expect(out).toMatchObject({ ok: false, retryable: true, errorKind: "transient" });
    expect(r.finished).toHaveLength(1);
    expect(r.finished[0]).toMatchObject({ status: "failed", kind: "snapshot", received: 0, written: 0, error: { kind: "transient", http_status: 503 } });
  });
  it("a connection that is not usable leaves no run", async () => {
    const r = memoryRuns();
    await mk(r.store, async () => RESULT, mint({ status: "reconnect_required" })).job.run("PKG", ID);
    expect(r.started).toEqual([]);
  });
  it("a run log that cannot start or finish is logged by code and never changes the result", async () => {
    for (const over of [{ startThrows: true }, { finishThrows: true }, { startNull: true }]) {
      const r = memoryRuns(over);
      const x = mk(r.store);
      expect(await x.job.run("PKG", ID)).toMatchObject({ ok: true, written: 15 });
      expect(JSON.stringify(x.l.lines)).not.toContain("Sync log unavailable");
    }
  });
  it("without a run store nothing is logged and the job works", async () => {
    expect(await mk(undefined).job.run("PKG", ID)).toMatchObject({ ok: true });
  });
});

describe("report pull run log", () => {
  const settings = (kinds: string[]) => ({ kinds, method: "Accrual", period: "month_to_date" } as never);
  const mk = (runs: SyncRunStore, opts: { kinds?: string[]; api?: unknown; settingsThrow?: boolean; conn?: ReturnType<typeof mint> } = {}) => {
    const l = logs();
    return createQboReportsJob({
      loader: { loadConnection: async () => opts.conn ?? mint() } as never,
      api: (opts.api ?? { get: async () => ({ data: { QueryResponse: {} } }) }) as never,
      store: { put: async () => undefined },
      settings: async () => { if (opts.settingsThrow) throw new ConnectorError({ kind: "provider_error", message: "The lane's report settings are not valid" }); return settings(opts.kinds ?? []); },
      payroll: async () => ({ accountIds: [], accountSubtypes: [], excludedEntityIds: [] }),
      logger: l.logger,
      runs,
    });
  };

  it("a run with nothing to fetch still logs a succeeded row (job reports)", async () => {
    const r = memoryRuns();
    expect(await mk(r.store).run("PKG", ID)).toMatchObject({ ok: true, stored: [] });
    expect(r.started).toEqual([{ job: "reports", trigger: "schedule" }]);
    expect(r.finished).toEqual([{ status: "succeeded", kind: "snapshot", received: 0, written: 0 }]);
  });
  it("unreadable settings fail the run and the row says so with the error info", async () => {
    const r = memoryRuns();
    expect(await mk(r.store, { settingsThrow: true }).run("PKG", ID)).toMatchObject({ ok: false });
    expect(r.finished[0]).toMatchObject({ status: "failed", error: { kind: "provider_error" } });
  });
  it("an Intuit failure on a report fails the row with the status and code, never a message of Intuit's", async () => {
    const r = memoryRuns();
    const api = { get: async (_l: string, _c: unknown, path: string) => {
      if (path.endsWith("/query")) return { data: { QueryResponse: {} } };
      throw new ConnectorError({ kind: "transient", message: "QuickBooks is not responding right now. It will be tried again shortly.", http_status: 503, provider_error_code: "10001" });
    } };
    const out = await mk(r.store, { kinds: ["pnl"], api }).run("PKG", ID);
    expect(out).toMatchObject({ ok: false, retryable: true });
    expect(r.finished[0]).toMatchObject({ status: "failed", error: { kind: "transient", http_status: 503, provider_error_code: "10001" } });
  });
  it("a run that failed after storing some reports records how many it stored", async () => {
    const r = memoryRuns();
    let n = 0;
    const api = { get: async (_l: string, _c: unknown, path: string) => {
      if (path.endsWith("/query")) return { data: { QueryResponse: {} } };
      n += 1;
      throw new ConnectorError({ kind: "transient", message: "x", http_status: 503 });
    } };
    await mk(r.store, { kinds: ["pnl", "balance_sheet"], api }).run("PKG", ID);
    expect(n).toBe(2);
    expect(r.finished[0]).toMatchObject({ status: "failed", received: 0, written: 0 });
  });
  it("the caller's trigger is recorded", async () => {
    const r = memoryRuns();
    await mk(r.store).run("PKG", ID, { trigger: "manual" });
    expect(r.started).toEqual([{ job: "reports", trigger: "manual" }]);
  });
  it("a connection that is not usable leaves no run; a run-log outage does not break the pull", async () => {
    const r = memoryRuns();
    await mk(r.store, { conn: mint({ status: "reconnect_required" }) }).run("PKG", ID);
    expect(r.started).toEqual([]);
    const down = memoryRuns({ startThrows: true });
    expect(await mk(down.store).run("PKG", ID)).toMatchObject({ ok: true });
  });
});
