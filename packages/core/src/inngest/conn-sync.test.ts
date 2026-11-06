// conn.sync Inngest function (T-038): concurrency key, retries, failure translation, lane check, registration.
import { NonRetriableError, RetryAfterError, Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { CONN_SYNC_CONCURRENCY, CONN_SYNC_RETRIES, connSyncFunction, handleConnSync, type ConnSyncDeps, type ConnSyncResult } from "./conn-sync";
import { connSyncRequested } from "./events";

const CONN = "00000000-0000-4000-8000-000000000381";
const CONN_A = "00000000-0000-4000-8000-000000000382";
const deps = (result: ConnSyncResult, lanes: string[] = ["PKG"]): ConnSyncDeps & { runSync: ReturnType<typeof vi.fn> } => ({
  runSync: vi.fn(async () => result),
  enabledLanes: () => lanes,
});
const ok: ConnSyncResult = { ok: true, skipped: null, runId: "r", kind: "full", received: 1, written: 1 };

describe("conn.sync function config", () => {
  it("is keyed by connection id with one run at a time, and retries", () => {
    expect(CONN_SYNC_CONCURRENCY).toEqual({ key: "event.data.connectionId", limit: 1 });
    expect(CONN_SYNC_RETRIES).toBeGreaterThanOrEqual(3);
    const fn = connSyncFunction(new Inngest({ id: "test-app", isDev: true }), deps(ok)) as unknown as { opts: Record<string, unknown>; id: () => string };
    const opts = JSON.parse(JSON.stringify(fn.opts)) as Record<string, unknown>;
    expect(opts.retries).toBe(CONN_SYNC_RETRIES);
    expect(opts.concurrency).toEqual(CONN_SYNC_CONCURRENCY);
    expect(opts.id).toBe("conn-sync");
  });

  it("is triggered by the typed conn/sync.requested event, which requires a lane", async () => {
    expect(connSyncRequested.name).toBe("conn/sync.requested");
    expect((await connSyncRequested.schema["~standard"].validate({ connectionId: CONN })).issues).toBeDefined();
    expect((await connSyncRequested.schema["~standard"].validate({ laneId: "PKG", connectionId: CONN, trigger: "schedule" })).issues).toBeUndefined();
    expect((await connSyncRequested.schema["~standard"].validate({ laneId: "PKG", connectionId: CONN, trigger: "nope" })).issues).toBeDefined();
  });
});

describe("handleConnSync", () => {
  it("passes lane, connection, trigger and the Inngest run id to the job", async () => {
    const d = deps(ok);
    await expect(handleConnSync(d, { laneId: "PKG", connectionId: CONN, trigger: "schedule" }, "01HZ")).resolves.toEqual(ok);
    expect(d.runSync).toHaveBeenCalledWith("PKG", CONN, { trigger: "schedule", jobRunId: "01HZ" });
    await handleConnSync(d, { laneId: "PKG", connectionId: CONN, trigger: "webhook" }, null);
    expect(d.runSync).toHaveBeenLastCalledWith("PKG", CONN, { trigger: "webhook", jobRunId: null });
  });

  it("refuses an event that skipped sendLaneEvent and is malformed, without calling the job", async () => {
    const d = deps(ok);
    for (const bad of [{ connectionId: CONN, trigger: "manual" }, { laneId: "PKG", connectionId: "not-a-uuid", trigger: "manual" }, { laneId: "pkg;", connectionId: CONN, trigger: "manual" }, { laneId: "PKG", connectionId: CONN, trigger: "manual", extra: 1 }, { laneId: "PKG", connectionId: CONN }]) {
      await expect(handleConnSync(d, bad as never, null)).rejects.toBeInstanceOf(NonRetriableError);
    }
    expect(d.runSync).not.toHaveBeenCalled();
  });

  it("does nothing for a lane this deployment does not serve", async () => {
    const d = deps(ok, ["PKG"]);
    await expect(handleConnSync(d, { laneId: "APK", connectionId: CONN, trigger: "manual" }, null)).resolves.toEqual({ ok: true, skipped: "lane_not_served" });
    expect(d.runSync).not.toHaveBeenCalled();
  });

  it("returns skips as success", async () => {
    await expect(handleConnSync(deps({ ok: true, skipped: "already_running" }), { laneId: "PKG", connectionId: CONN, trigger: "manual" }, null)).resolves.toEqual({ ok: true, skipped: "already_running" });
  });

  it("a permanent failure is not retried", async () => {
    const fail: ConnSyncResult = { ok: false, retryable: false, retryAfterSeconds: null, errorKind: "reconnect_required", message: "m" };
    await expect(handleConnSync(deps(fail), { laneId: "PKG", connectionId: CONN, trigger: "manual" }, null)).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("a transient failure is retried, honouring a capped retry-after", async () => {
    const plain: ConnSyncResult = { ok: false, retryable: true, retryAfterSeconds: null, errorKind: "transient", message: "m" };
    const err = await handleConnSync(deps(plain), { laneId: "PKG", connectionId: CONN, trigger: "manual" }, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetriableError);
    expect(err).not.toBeInstanceOf(RetryAfterError);
    const limited = await handleConnSync(deps({ ...plain, retryAfterSeconds: 30 }), { laneId: "PKG", connectionId: CONN, trigger: "manual" }, null).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(RetryAfterError);
    const huge = await handleConnSync(deps({ ...plain, retryAfterSeconds: 999_999 }), { laneId: "PKG", connectionId: CONN, trigger: "manual" }, null).catch((e: unknown) => e as RetryAfterError);
    expect(String((huge as RetryAfterError).retryAfter)).not.toContain("999999");
  });

  it("one connection failing does not affect another (independent calls)", async () => {
    const runSync = vi.fn(async (_l: string, id: string): Promise<ConnSyncResult> => (id === CONN_A ? { ok: false, retryable: true, retryAfterSeconds: null, errorKind: "transient", message: "m" } : ok));
    const d = { runSync, enabledLanes: () => ["PKG"] };
    const [a, b] = await Promise.allSettled([handleConnSync(d, { laneId: "PKG", connectionId: CONN_A, trigger: "manual" }, null), handleConnSync(d, { laneId: "PKG", connectionId: CONN, trigger: "manual" }, null)]);
    expect(a.status).toBe("rejected");
    expect(b).toMatchObject({ status: "fulfilled", value: ok });
  });
});
