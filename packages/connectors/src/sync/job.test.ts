// conn.sync job (T-038) with the mock provider, an in-memory run log that enforces one running row per connection, and an
// in-memory cursor store with the same compare-and-swap as core.sync_cursor_put. Synthetic data only.
import { describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import type { Connection } from "../contract/schemas";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { createMockConnector, MOCK_AUTH_CODE, MOCK_SECRET_CANARY, testSchemas } from "../testing/index";
import { createConnSyncJob } from "./job";
import { createConnectorSyncRunner, createGoogleSyncRunner } from "./runners";
import type { SyncCursorStore, SyncRunFinish, SyncRunStore, SyncRunner } from "./types";

type RunRow = { id: string; connectionId: string; laneId: string; status: "running" | "succeeded" | "failed" | "cancelled"; jobRunId: string | null; result?: SyncRunFinish };

function memoryRuns() {
  const rows: RunRow[] = [];
  const outcomes = new Map<string, { ok: boolean; error?: unknown }>();
  let n = 0;
  const store: SyncRunStore = {
    async start(laneId, conn, input) {
      for (const r of rows) if (r.connectionId === conn.id && r.status === "running" && input.jobRunId && r.jobRunId === input.jobRunId) r.status = "cancelled";
      if (rows.some((r) => r.connectionId === conn.id && r.status === "running")) return null;
      const row: RunRow = { id: `run-${++n}`, connectionId: conn.id, laneId, status: "running", jobRunId: input.jobRunId };
      rows.push(row);
      return { runId: row.id };
    },
    async finish(_laneId, _conn, runId, result) {
      const row = rows.find((r) => r.id === runId && r.status === "running");
      if (!row) throw new Error("no running row");
      row.status = result.status;
      row.result = result;
    },
    async recordOutcome(_laneId, conn, outcome) {
      outcomes.set(conn.id, outcome);
    },
  };
  return { store, rows, outcomes };
}

function memoryCursors() {
  const m = new Map<string, string>();
  const store: SyncCursorStore = {
    async get(_l, conn) {
      return m.get(conn.id) ?? null;
    },
    async put(_l, conn, expected, next) {
      if ((m.get(conn.id) ?? null) !== expected) return false;
      m.set(conn.id, next);
      return true;
    },
  };
  return { store, m };
}

async function setup(opts: { failFor?: (connId: string) => ConnectorError | null } = {}) {
  const mock = createMockConnector();
  const a = await mock.connector.connect("PKG", { kind: "oauth_code", code: MOCK_AUTH_CODE, redirect_uri: "https://portal.example.test/api/connect/mock/callback", external_account_id: "acct-a" });
  const b = await mock.connector.connect("PKG", { kind: "oauth_code", code: MOCK_AUTH_CODE, redirect_uri: "https://portal.example.test/api/connect/mock/callback", external_account_id: "acct-b" });
  const base = mock.connector;
  const connector = { ...base, sync: async (...args: Parameters<NonNullable<typeof base.sync>>) => {
    const err = opts.failFor?.(args[1].id);
    if (err) throw err;
    if (!base.sync) throw new Error("mock has no sync");
    return base.sync(...args);
  } };
  const runs = memoryRuns();
  const cursors = memoryCursors();
  const entries: LogEntry[] = [];
  const logger = createConnectorLogger({ sink: (e) => entries.push(e) });
  const delivered: string[] = [];
  const runner = createConnectorSyncRunner({ connector, cursors: cursors.store, sinkFor: (_l, conn) => async (batch) => { for (const r of batch) delivered.push(`${conn.id}:${r.external_id}`); } });
  const job = createConnSyncJob({ loader: mock.loader, runs: runs.store, runners: { [base.provider]: runner }, logger });
  return { mock, a, b, job, runs, cursors, entries, delivered };
}

describe("targeted runs (T-053)", () => {
  async function targeted(refuseTargeted = false) {
    const mock = createMockConnector();
    const a = await mock.connector.connect("PKG", { kind: "oauth_code", code: MOCK_AUTH_CODE, redirect_uri: "https://portal.example.test/api/connect/mock/callback", external_account_id: "acct-t" });
    const seen: unknown[] = [];
    const base = mock.connector;
    const connector = { ...base, sync: async (...args: Parameters<NonNullable<typeof base.sync>>) => {
      seen.push(args[4]);
      // The QuickBooks connector refuses a targeted run with an unusable (too old) cursor before any call, as invalid_input.
      if (refuseTargeted && args[4]) throw new ConnectorError({ kind: "invalid_input", message: "A targeted sync needs a current cursor" });
      if (!base.sync) throw new Error("no sync");
      return base.sync(...args);
    } };
    const cursors = memoryCursors();
    const runner = createConnectorSyncRunner({ connector, cursors: cursors.store, sinkFor: () => async () => {} });
    const job = createConnSyncJob({ loader: mock.loader, runs: memoryRuns().store, runners: { [base.provider]: runner } });
    return { a, job, seen };
  }

  it("falls back to a whole-connection run when the connector refuses a targeted run for an unusable cursor", async () => {
    const s = await targeted(true);
    await s.job.run("PKG", s.a.id, { trigger: "schedule" });
    const out = await s.job.run("PKG", s.a.id, { trigger: "webhook", objectTypes: ["Invoice"] });
    expect(out).toMatchObject({ ok: true, skipped: null });
    expect(s.seen.slice(1)).toEqual([{ objectTypes: ["Invoice"] }, undefined]);
  });

  it("passes the requested object types to the connector once a cursor exists, and a first run stays a full sync", async () => {
    const s = await targeted();
    await s.job.run("PKG", s.a.id, { trigger: "webhook", objectTypes: ["Invoice"] });
    expect(s.seen).toEqual([undefined]); // no cursor yet: the whole connection is loaded
    await s.job.run("PKG", s.a.id, { trigger: "webhook", objectTypes: ["Invoice", "Bill"] });
    expect(s.seen.at(-1)).toEqual({ objectTypes: ["Invoice", "Bill"] });
    await s.job.run("PKG", s.a.id, { trigger: "schedule" });
    expect(s.seen.at(-1)).toBeUndefined();
    await s.job.run("PKG", s.a.id, { trigger: "webhook", objectTypes: [] });
    expect(s.seen.at(-1)).toBeUndefined();
  });
});

describe("conn.sync job", () => {
  it("runs a full sync, logs start and finish, stores the cursor after success", async () => {
    const s = await setup();
    const out = await s.job.run("PKG", s.a.id, { trigger: "schedule", jobRunId: "01HZ" });
    expect(out).toMatchObject({ ok: true, skipped: null, kind: "full", received: 3, written: 3 });
    expect(s.runs.rows).toHaveLength(1);
    expect(s.runs.rows[0]).toMatchObject({ status: "succeeded", jobRunId: "01HZ", result: { kind: "full", received: 3, written: 3 } });
    expect(s.cursors.m.get(s.a.id)).toBeTruthy();
    expect(s.runs.outcomes.get(s.a.id)).toEqual({ ok: true });
  });

  it("a second run is incremental from the stored cursor", async () => {
    const s = await setup();
    await s.job.run("PKG", s.a.id, { trigger: "schedule" });
    const again = await s.job.run("PKG", s.a.id, { trigger: "schedule" });
    expect(again).toMatchObject({ ok: true, kind: "incremental", received: 0 });
    expect(s.runs.rows.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("one connection failing does not block another; the failed one keeps its cursor and logs a redacted error", async () => {
    let failId = "";
    const s = await setup({ failFor: (id) => (id === failId ? new ConnectorError({ kind: "transient", message: `upstream 503 Bearer ${MOCK_SECRET_CANARY}`, retry_after_seconds: 7 }) : null) });
    failId = s.a.id;
    const [failed, ok] = await Promise.all([s.job.run("PKG", s.a.id, { trigger: "schedule" }), s.job.run("PKG", s.b.id, { trigger: "schedule" })]);
    expect(failed).toMatchObject({ ok: false, retryable: true, retryAfterSeconds: 7, errorKind: "transient" });
    expect(ok).toMatchObject({ ok: true, skipped: null, written: 3 });
    const ra = s.runs.rows.find((r) => r.connectionId === s.a.id);
    const rb = s.runs.rows.find((r) => r.connectionId === s.b.id);
    expect(ra?.status).toBe("failed");
    expect(rb?.status).toBe("succeeded");
    expect(ra?.result?.error?.kind).toBe("transient");
    expect(JSON.stringify([ra?.result, s.entries, failed])).not.toContain(MOCK_SECRET_CANARY);
    expect(s.cursors.m.has(s.a.id)).toBe(false); // a failed run never advances the cursor
    expect(s.cursors.m.has(s.b.id)).toBe(true);
    expect(s.runs.outcomes.get(s.a.id)).toMatchObject({ ok: false });
    expect(s.runs.outcomes.get(s.b.id)).toEqual({ ok: true });
  });

  it("a retry after a failure starts a new run and takes over an open row of the same job run", async () => {
    let fail = true;
    const s = await setup({ failFor: () => (fail ? new ConnectorError({ kind: "timeout", message: "slow" }) : null) });
    const first = await s.job.run("PKG", s.a.id, { trigger: "schedule", jobRunId: "run1" });
    expect(first).toMatchObject({ ok: false, retryable: true });
    fail = false;
    const second = await s.job.run("PKG", s.a.id, { trigger: "schedule", jobRunId: "run1" });
    expect(second).toMatchObject({ ok: true, written: 3 });
    expect(s.runs.rows.map((r) => r.status)).toEqual(["failed", "succeeded"]);
  });

  it("reconnect_required is not retryable", async () => {
    const s = await setup({ failFor: () => new ConnectorError({ kind: "reconnect_required", message: "invalid_grant" }) });
    expect(await s.job.run("PKG", s.a.id, { trigger: "manual" })).toMatchObject({ ok: false, retryable: false, errorKind: "reconnect_required" });
  });

  it("skips when another run is genuinely running, without touching it", async () => {
    const s = await setup();
    await s.runs.store.start("PKG", s.a, { trigger: "manual", jobRunId: "other" });
    expect(await s.job.run("PKG", s.a.id, { trigger: "schedule", jobRunId: "mine" })).toEqual({ ok: true, skipped: "already_running" });
    expect(s.runs.rows).toHaveLength(1);
    expect(s.runs.rows[0]?.status).toBe("running");
  });

  it("skips a connection that is not usable and fails a provider without a runner", async () => {
    const s = await setup();
    const loader = { loadConnection: async (l: string, id: string) => mintLaneBoundConnection({ ...(await s.mock.loader.loadConnection(l, id)), status: "reconnect_required" } as Connection<string>, testSchemas.ConnectionSchema as never) };
    const skipJob = createConnSyncJob({ loader, runs: s.runs.store, runners: {} });
    expect(await skipJob.run("PKG", s.a.id, { trigger: "schedule" })).toEqual({ ok: true, skipped: "connection_not_usable" });
    expect(s.runs.rows).toHaveLength(0);
    const bare = createConnSyncJob({ loader: s.mock.loader, runs: s.runs.store, runners: {} });
    expect(await bare.run("PKG", s.a.id, { trigger: "schedule" })).toMatchObject({ ok: false, retryable: false, errorKind: "unsupported_op" });
    expect(s.runs.rows[0]?.status).toBe("failed");
  });

  it("another lane's connection id is not found (nothing logged)", async () => {
    const s = await setup();
    expect(await s.job.run("APK", s.a.id, { trigger: "manual" })).toMatchObject({ ok: false, retryable: false, errorKind: "not_found" });
    expect(s.runs.rows).toHaveLength(0);
  });

  it("a failing run log never turns a finished sync into a retry, and a permanent failure still closes its row", async () => {
    const s = await setup();
    const brokenFinish: SyncRunStore = { ...s.runs.store, finish: async () => { throw new ConnectorError({ kind: "transient", message: "Sync log unavailable" }); }, recordOutcome: async () => { throw new ConnectorError({ kind: "transient", message: "x" }); } };
    const recorded = s.runs.outcomes.size;
    const okJob = createConnSyncJob({ loader: s.mock.loader, runs: brokenFinish, runners: { [s.a.provider]: async () => ({ kind: "full", received: 1, written: 1 }) } });
    expect(await okJob.run("PKG", s.a.id, { trigger: "schedule" })).toMatchObject({ ok: true, skipped: null, written: 1 });
    expect(s.runs.outcomes.size).toBe(recorded); // the connection's last-sync state follows only a closed run row
    // A permanent failure whose "failed" log write fails: the job tries to cancel the row so the connection is not blocked.
    const s2 = await setup();
    let first = true;
    const flaky: SyncRunStore = { ...s2.runs.store, finish: async (l, c, id, r) => { if (first && r.status === "failed") { first = false; throw new ConnectorError({ kind: "transient", message: "x" }); } return s2.runs.store.finish(l, c, id, r); } };
    const failJob = createConnSyncJob({ loader: s2.mock.loader, runs: flaky, runners: { [s2.a.provider]: async () => { throw new ConnectorError({ kind: "forbidden", message: "no" }); } } });
    expect(await failJob.run("PKG", s2.a.id, { trigger: "schedule" })).toMatchObject({ ok: false, retryable: false });
    expect(s2.runs.rows.map((r) => r.status)).toEqual(["cancelled"]);
    expect(await failJob.run("PKG", s2.a.id, { trigger: "schedule" })).toMatchObject({ ok: false, retryable: false }); // not skipped as already_running
  });

  it("an attempt that died with its row open is taken over by the retry of the same job run", async () => {
    const s = await setup();
    const open = await s.runs.store.start("PKG", s.a, { trigger: "schedule", jobRunId: "run9" }); // the earlier attempt crashed here
    expect(open).not.toBeNull();
    const out = await s.job.run("PKG", s.a.id, { trigger: "schedule", jobRunId: "run9" });
    expect(out).toMatchObject({ ok: true, written: 3 });
    expect(s.runs.rows.map((r) => r.status)).toEqual(["cancelled", "succeeded"]);
  });

  it("ignores a job run id that is not a plain id", async () => {
    const s = await setup();
    await s.job.run("PKG", s.a.id, { trigger: "manual", jobRunId: "bad id; drop" });
    expect(s.runs.rows[0]?.jobRunId).toBeNull();
  });
});

describe("provider runners", () => {
  it("the cursor compare-and-swap: a duplicate run that lost the race does not move the cursor back", async () => {
    const s = await setup();
    const c = memoryCursors();
    const runner = createConnectorSyncRunner({ connector: s.mock.connector, cursors: { get: c.store.get, put: async () => false }, sinkFor: () => async () => {} });
    await expect(runner("PKG", s.a)).resolves.toMatchObject({ kind: "full", written: 3 });
    expect(c.m.size).toBe(0);
  });

  it("refuses a connection forged for the runner", async () => {
    const s = await setup();
    const runner = createConnectorSyncRunner({ connector: s.mock.connector, cursors: s.cursors.store, sinkFor: () => async () => {} });
    await expect(runner("PKG", { ...s.a } as LaneBoundConnection<string>)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
  });

  it("the Google runner runs mail and calendar, finishes the other when one fails, and rethrows the failure", async () => {
    const s = await setup();
    const calls: string[] = [];
    const ok = (name: string) => ({ run: async () => { calls.push(name); return { written: 2, skipped: 1, removed: 1, mode: "incremental" as const }; } });
    const bad = (name: string) => ({ run: async () => { calls.push(name); throw new ConnectorError({ kind: "rate_limited", message: "slow down" }); } });
    await expect(createGoogleSyncRunner({ mail: ok("mail"), calendar: ok("cal") })("PKG", s.a)).resolves.toEqual({ kind: "incremental", received: 8, written: 4 });
    calls.length = 0;
    await expect(createGoogleSyncRunner({ mail: bad("mail"), calendar: ok("cal") })("PKG", s.a)).rejects.toMatchObject({ info: { kind: "rate_limited" } });
    expect(calls).toEqual(["mail", "cal"]);
    // A permanent failure on one stream does not hide a retryable one on the other.
    const permanent = { run: async () => { throw new ConnectorError({ kind: "reconnect_required", message: "grant" }); } };
    await expect(createGoogleSyncRunner({ mail: permanent, calendar: bad("cal") })("PKG", s.a)).rejects.toMatchObject({ info: { kind: "rate_limited" } });
  });
});

describe("SyncRunner type", () => {
  it("is a function of lane and connection", () => {
    const r: SyncRunner = async () => ({ kind: "full", received: 0, written: 0 });
    expect(typeof r).toBe("function");
  });
});
