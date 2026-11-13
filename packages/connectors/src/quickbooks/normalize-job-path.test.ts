// T-242: the FULL normalizer job path with the real job, the real normalizer store and the real run log, over a fake job client
// that answers each database call like PostgREST does. Production: the function succeeds when called directly, the job fails
// with SQLSTATE 21000. These tests pin which call each failure is reported under, so the run output names the real failing call.
import { describe, expect, it } from "vitest";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import { handleFinNormalize } from "@nichols/core/inngest";
import { createNormalizeStore } from "./normalize-store";
import { createQboNormalizeJob } from "./normalize-job";
import type { SyncRunStore } from "../sync/types";

const ID = "00000000-0000-4000-8000-0000000000c2";
const conn = mintLaneBoundConnection<string>({
  id: ID, lane_id: "PKG", provider: "quickbooks", external_account_id: "9341450000000002", status: "active",
  features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null,
} as never);
const t = { inserted: 2, updated: 0, tombstoned: 0, invalid: 0 };
const OK = {
  class_tracking: false, class_fallback: false, class_fallback_rows: 0, unmapped_rows: 0, null_account_lines: 0, invalid_records: 0,
  dead_deleted: 0, dead_unseen: 0, dead_payroll: 0, dead_entity: 0, dead_linked: 0,
  accounts: t, invoices: t, bills: t, payments: { ...t, reallocated: 0 }, transactions: t,
};

/** The run log as the job sees it: rows opened and closed, in order (core.sync_runs, job = normalize). */
function runLog() {
  const calls: string[] = [];
  const rows: { status: string; error?: { message?: string } }[] = [];
  const store: SyncRunStore = {
    async start(_l, _c, input) { calls.push(`sync_runs.start(${input.job ?? "sync"})`); rows.push({ status: "running" }); return { runId: "r1" }; },
    async finish(_l, _c, _id, result) { calls.push(`sync_runs.finish(${result.status})`); Object.assign(rows[rows.length - 1] ?? {}, { status: result.status, error: result.error }); },
    async recordOutcome() { calls.push("connections.recordOutcome"); },
  };
  return { calls, rows, store };
}

/** A job client whose RPC answers like PostgREST: data, or { error: { code, message } }. Records every database call. */
function client(rpc: { data?: unknown; error?: { code: string; message: string } }) {
  const calls: string[] = [];
  const c = { schema: (s: string) => ({ rpc: (fn: string) => { calls.push(`${s}.${fn}`); return { abortSignal: async () => ({ data: rpc.data ?? null, error: rpc.error ?? null }) }; } }) };
  return { calls, clientFor: async () => c as never };
}

function path(rpc: Parameters<typeof client>[0]) {
  const db = client(rpc);
  const runs = runLog();
  const job = createQboNormalizeJob({ loader: { loadConnection: async () => conn } as never, store: createNormalizeStore(db.clientFor), runs: runs.store });
  return { db, runs, job };
}

describe("T-242: the normalizer job path, end to end", () => {
  it("success: one run row opened and closed succeeded around exactly one rpc core.fin_qbo_normalize", async () => {
    const p = path({ data: OK });
    const out = await p.job.run("PKG", ID, { trigger: "manual" });
    expect(out).toMatchObject({ ok: true, skipped: null, written: 10 });
    expect([...p.runs.calls.slice(0, 1), ...p.db.calls, ...p.runs.calls.slice(1)]).toEqual(["sync_runs.start(normalize)", "core.fin_qbo_normalize", "sync_runs.finish(succeeded)"]);
  });

  it("21000 raised OUTSIDE the function's main block (production: the direct call succeeds): permanent, named as the rpc, outside", async () => {
    const p = path({ error: { code: "21000", message: "more than one row returned by a subquery used as an expression" } });
    const out = await p.job.run("PKG", ID, { trigger: "manual" });
    expect(out).toMatchObject({ ok: false, retryable: false, errorKind: "provider_error",
      message: "The normalizer found two rows for one record (SQLSTATE 21000, rpc fin_qbo_normalize, outside the function's main block)" });
    expect(p.runs.rows[0]).toMatchObject({ status: "failed", error: { message: expect.stringContaining("outside the function's main block") } });
    // The Inngest run output shows the same reason (and Inngest does not retry it).
    const err = (await handleFinNormalize({ runNormalize: async () => out as never, enabledLanes: () => ["PKG"] }, { laneId: "PKG", connectionId: ID, trigger: "manual" }).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("fin.qbo_normalize failed: provider_error: The normalizer found two rows for one record (SQLSTATE 21000, rpc fin_qbo_normalize, outside the function's main block)");
    expect(err.constructor.name).toBe("NonRetriableError");
  });

  it("21000 inside the function names the step; other database codes name the rpc and where too; no database text anywhere", async () => {
    const inside = await path({ error: { code: "21000", message: "fin.qbo_normalize failed: SQLSTATE 21000, table -, constraint -, step transaction_keys" } }).job.run("PKG", ID, { trigger: "manual" });
    expect(inside).toMatchObject({ message: "The normalizer found two rows for one record (SQLSTATE 21000, rpc fin_qbo_normalize, step transaction_keys)" });
    const lock = await path({ error: { code: "55P03", message: "could not obtain lock on row in relation \"invoices\" Acme SECRET" } }).job.run("PKG", ID, { trigger: "manual" });
    expect(lock).toMatchObject({ ok: false, retryable: true, message: "Normalizer unavailable: lock or serialization conflict (SQLSTATE 55P03), rpc fin_qbo_normalize, outside the function's main block" });
    expect(JSON.stringify([inside, lock])).not.toMatch(/Acme|SECRET|subquery/);
  });
});
