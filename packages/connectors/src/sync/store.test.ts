// The run log and cursor stores (T-038) against a recording fake of the job client: which table, which filters, which
// values. The database side (index, compare-and-swap) is covered by pgTAP 180_conn_sync_cursor_put.
import { describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import type { Connection } from "../contract/schemas";
import { createSyncCursorStore, createSyncRunStore, GENERIC_STREAM, STALE_RUN_MS } from "./store";

const CONN_ID = "00000000-0000-4000-8000-000000000381";
const conn = mintLaneBoundConnection({
  id: CONN_ID, lane_id: "PKG", provider: "quickbooks", external_account_id: "realm-1", status: "active", features: {},
  features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null,
} as Connection);

type Call = { table: string; op: string; values?: unknown; filters: [string, string, unknown][] };

function fakeClient(respond: (c: Call) => { data?: unknown; error?: { code?: string } | null } = () => ({ data: { id: "run-1" } })) {
  const calls: Call[] = [];
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const builder = (call: Call) => {
    const b: Record<string, unknown> = {};
    for (const op of ["eq", "lt", "or"]) b[op] = (col: string, v?: unknown) => { call.filters.push([op, col, v]); return b; };
    b.select = () => b;
    b.single = () => Promise.resolve({ data: respond(call).data ?? null, error: respond(call).error ?? null });
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: Array.isArray(respond(call).data) ? respond(call).data : [{ id: "run-1" }], error: respond(call).error ?? null }).then(res);
    return b;
  };
  const schema = {
    from: (table: string) => ({
      insert: (values: unknown) => { const c: Call = { table, op: "insert", values, filters: [] }; calls.push(c); return builder(c); },
      update: (values: unknown) => { const c: Call = { table, op: "update", values, filters: [] }; calls.push(c); return builder(c); },
    }),
    rpc: (fn: string, args: Record<string, unknown>) => { rpcs.push({ fn, args }); return Promise.resolve({ data: fn === "sync_cursor_put" ? true : "cur-1", error: null }); },
  };
  const client = { schema: () => schema };
  return { calls, rpcs, clientFor: async () => client as never };
}

const NOW = new Date("2026-11-05T12:00:00.000Z");

describe("sync run store", () => {
  it("start cancels stale and same-job-run rows (lane and connection scoped), then inserts", async () => {
    const f = fakeClient();
    const store = createSyncRunStore(f.clientFor, () => NOW);
    await expect(store.start("PKG", conn, { trigger: "schedule", jobRunId: "run1" })).resolves.toEqual({ runId: "run-1" });
    expect(f.calls.map((c) => c.op)).toEqual(["update", "update", "insert"]);
    const [stale, own, insert] = f.calls as [Call, Call, Call];
    for (const c of [stale, own]) {
      expect(c.table).toBe("sync_runs");
      expect(c.values).toMatchObject({ status: "cancelled" });
      expect(c.filters).toEqual(expect.arrayContaining([["eq", "lane_id", "PKG"], ["eq", "connection_id", CONN_ID], ["eq", "status", "running"]]));
    }
    expect(stale.filters).toContainEqual(["lt", "started_at", new Date(NOW.getTime() - STALE_RUN_MS).toISOString()]);
    expect(own.filters).toContainEqual(["eq", "job_run_id", "run1"]);
    expect(insert.values).toMatchObject({ lane_id: "PKG", connection_id: CONN_ID, trigger: "schedule", job_run_id: "run1", kind: "full" });
  });

  it("T-196: a sync is job sync, full or incremental; reports and normalize are snapshots, and the stale cancel is scoped to the same job", async () => {
    const f = fakeClient();
    const store = createSyncRunStore(f.clientFor, () => NOW);
    await store.start("PKG", conn, { trigger: "schedule", jobRunId: null });
    await store.start("PKG", conn, { trigger: "schedule", jobRunId: null, job: "reports" });
    const inserts = f.calls.filter((c) => c.op === "insert");
    expect(inserts[0]?.values).toMatchObject({ kind: "full" });
    expect(inserts[0]?.values).not.toHaveProperty("job"); // the database default applies: old SQL + new code still works for conn.sync
    expect(inserts[1]?.values).toMatchObject({ job: "reports", kind: "snapshot" });
    const cancels = f.calls.filter((c) => c.op === "update");
    expect(cancels[0]?.filters.map((f) => f[1])).not.toContain("job");
    expect(cancels[1]?.filters).toContainEqual(["eq", "job", "reports"]);
  });

  it("start returns null when the one-running index refuses the insert", async () => {
    const f = fakeClient((c) => (c.op === "insert" ? { error: { code: "23505" } } : {}));
    await expect(createSyncRunStore(f.clientFor).start("PKG", conn, { trigger: "manual", jobRunId: null })).resolves.toBeNull();
  });

  it("other database errors become a transient ConnectorError without the database text", async () => {
    const f = fakeClient((c) => (c.op === "insert" ? { error: { code: "XX000" } } : {}));
    await expect(createSyncRunStore(f.clientFor).start("PKG", conn, { trigger: "manual", jobRunId: null })).rejects.toMatchObject({ info: { kind: "transient", message: "Sync log unavailable" } });
  });

  it("finish only updates the still-running row of this lane and connection; a failure stores the error, a success clears it", async () => {
    const f = fakeClient();
    const store = createSyncRunStore(f.clientFor, () => NOW);
    const error = new ConnectorError({ kind: "transient", message: "x" }).toJSON();
    await store.finish("PKG", conn, "run-1", { status: "failed", kind: "full", received: 0, written: 0, error });
    await store.finish("PKG", conn, "run-2", { status: "succeeded", kind: "full", received: 3, written: 3, error });
    expect(f.calls[0]?.values).toMatchObject({ status: "failed", error, finished_at: NOW.toISOString() });
    expect(f.calls[1]?.values).toMatchObject({ status: "succeeded", error: null, records_written: 3 });
    expect(f.calls[0]?.filters).toEqual(expect.arrayContaining([["eq", "id", "run-1"], ["eq", "lane_id", "PKG"], ["eq", "connection_id", CONN_ID], ["eq", "status", "running"]]));
  });

  it("finish reports a run that is no longer running (cancelled meanwhile) as a log failure", async () => {
    const f = fakeClient((c) => (c.op === "update" ? { data: [] } : {}));
    await expect(createSyncRunStore(f.clientFor).finish("PKG", conn, "run-1", { status: "succeeded", kind: "full", received: 0, written: 0 })).rejects.toMatchObject({ info: { message: "Sync log unavailable" } });
  });

  it("recordOutcome updates last_sync_at or last_error on this lane's connection only", async () => {
    const f = fakeClient();
    const store = createSyncRunStore(f.clientFor, () => NOW);
    await store.recordOutcome("PKG", conn, { ok: true });
    await store.recordOutcome("PKG", conn, { ok: false, error: new ConnectorError({ kind: "timeout", message: "t" }).toJSON() });
    expect(f.calls[0]).toMatchObject({ table: "connections", values: { last_sync_at: NOW.toISOString(), last_error: null } });
    expect(f.calls[1]?.values).not.toHaveProperty("status");
    expect(f.calls[1]?.filters).toEqual(expect.arrayContaining([["eq", "lane_id", "PKG"], ["eq", "id", CONN_ID]]));
  });

  it("T-238: a one-stream run tags its failure with the stream, and its success clears only that stream's (or the whole connection's) error", async () => {
    const f = fakeClient();
    const store = createSyncRunStore(f.clientFor, () => NOW);
    const err = new ConnectorError({ kind: "forbidden", message: "f" }).toJSON();
    await store.recordOutcome("PKG", conn, { ok: false, error: err }, "calendar");
    expect(f.calls[0]).toMatchObject({ table: "connections", op: "update", values: { last_error: err, last_error_stream: "calendar" } });
    await store.recordOutcome("PKG", conn, { ok: true }, "mail");
    // last_sync_at moves; last_error is cleared only where it is mail's or the whole connection's (the calendar error stays)
    expect(f.calls[1]).toMatchObject({ values: { last_sync_at: NOW.toISOString() } });
    expect(f.calls[1]?.values).not.toHaveProperty("last_error");
    expect(f.calls[2]).toMatchObject({ values: { last_error: null } });
    expect(f.calls[2]?.filters).toEqual(expect.arrayContaining([["eq", "lane_id", "PKG"], ["eq", "id", CONN_ID], ["or", "last_error_stream.is.null,last_error_stream.eq.mail", undefined]]));
    // a run of both streams (no stream) clears any error and tags a failure with null
    await store.recordOutcome("PKG", conn, { ok: false, error: err });
    expect(f.calls[3]?.values).toMatchObject({ last_error_stream: null });
    await store.recordOutcome("PKG", conn, { ok: true });
    expect(f.calls[4]).toMatchObject({ values: { last_sync_at: NOW.toISOString(), last_error: null } });
    expect(f.calls[4]?.filters.some(([op]) => op === "or")).toBe(false);
  });

  it("refuses a connection that is not bound to the lane", async () => {
    const store = createSyncRunStore(fakeClient().clientFor);
    await expect(store.start("APK", conn, { trigger: "manual", jobRunId: null })).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
  });
});

describe("sync cursor store", () => {
  it("reads and compare-and-swaps the generic stream through the lane-checked functions", async () => {
    const f = fakeClient();
    const store = createSyncCursorStore(f.clientFor);
    expect(await store.get("PKG", conn)).toBe("cur-1");
    expect(await store.put("PKG", conn, "cur-1", "cur-2")).toBe(true);
    expect(f.rpcs).toEqual([
      { fn: "sync_cursor_get", args: { p_lane: "PKG", p_connection_id: CONN_ID, p_stream: GENERIC_STREAM } },
      { fn: "sync_cursor_put", args: { p_lane: "PKG", p_connection_id: CONN_ID, p_stream: GENERIC_STREAM, p_expected: "cur-1", p_cursor: "cur-2" } },
    ]);
  });
});
