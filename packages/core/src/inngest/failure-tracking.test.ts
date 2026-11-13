// T-238 part E: failure tracking of scheduled functions: counting, reset, alert once per streak, lane keys, conn.sync per stream, no
// content, and that the wrapper changes nothing for other functions. A fake client records createFunction; the tracker is in memory.
import { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { FAILURE_ALERT_THRESHOLD, failureCode, withFailureTracking, type FailureTracker } from "./failure-tracking";
import { calIngestFunction } from "./cal-ingest";
import { connHealthFunctions } from "./conn-health";

const CONN = "00000000-0000-4000-8000-0000000000b1";

/** An in-memory twin of core.job_failure_record / _clear (same rules as the SQL: count, alert once at 3, reset). */
function memoryTracker(lanes: string[] = ["PKG"], over: Partial<FailureTracker> = {}) {
  const rows = new Map<string, { n: number; alerted: boolean; code: string }>();
  const key = (l: string, f: string, c: string) => `${l}|${f}|${c}`;
  const tracker: FailureTracker = {
    enabledLanes: () => lanes,
    async recordFailure(l, f, c, code) {
      const r = rows.get(key(l, f, c)) ?? { n: 0, alerted: false, code };
      r.n += 1;
      r.code = code;
      const alert = r.n >= FAILURE_ALERT_THRESHOLD && !r.alerted;
      if (alert) r.alerted = true;
      rows.set(key(l, f, c), r);
      return { consecutive: r.n, alert };
    },
    async recordSuccess(l, f, c) {
      const r = rows.get(key(l, f, c));
      if (r) Object.assign(r, { n: 0, alerted: false });
    },
    ...over,
  };
  return { tracker, rows, key };
}

type Registered = { options: Record<string, unknown>; handler: (ctx: unknown) => Promise<unknown> };
function fakeClient() {
  const registered: Registered[] = [];
  const client = { createFunction: (options: Record<string, unknown>, handler: Registered["handler"]) => { registered.push({ options, handler }); return { options }; }, other: () => "x" };
  return { client: client as unknown as Inngest, registered };
}
const cron = { id: "cal-ingest-delta", triggers: [{ cron: "*/15 * * * *" }] };
const failureCtx = (original: unknown, error: unknown) => ({ event: { data: { event: { data: original } } }, error });

describe("failureCode", () => {
  it("is a connector kind, lane_unavailable or failed; never the message", () => {
    expect(failureCode(new Error("conn.sync failed: reconnect_required"))).toBe("reconnect_required");
    expect(failureCode(new Error("conn.sync failed: transient"))).toBe("transient");
    expect(failureCode(new Error("cal.ingest_delta: 2 lane(s) could not be listed"))).toBe("lane_unavailable");
    expect(failureCode(new Error("conn.sync failed: jane@example.test"))).toBe("failed");
    expect(failureCode(new Error("conn.sync failed: made_up_kind"))).toBe("failed");
    expect(failureCode(new Error("Bearer abc 4111111111111111"))).toBe("failed");
    expect(failureCode(undefined)).toBe("failed");
    expect(failureCode("x")).toBe("failed");
  });
});

describe("what is tracked", () => {
  it("every cron-triggered function gets onFailure and a success mark; other event functions are left alone", () => {
    const { client, registered } = fakeClient();
    const t = withFailureTracking(client, memoryTracker().tracker);
    const handler = async () => "ok";
    t.createFunction({ id: "a-cron", triggers: [{ cron: "* * * * *" }] } as never, handler as never);
    t.createFunction({ id: "an-event-fn", triggers: [{ event: "x/y" }] } as never, handler as never);
    t.createFunction({ id: "conn-sync", triggers: [{ event: "conn/sync.requested" }] } as never, handler as never);
    expect(registered.map((r) => [r.options.id, typeof r.options.onFailure])).toEqual([["a-cron", "function"], ["an-event-fn", "undefined"], ["conn-sync", "function"]]);
    expect(registered[1]?.handler).toBe(handler); // untouched
    expect(registered[0]?.handler).not.toBe(handler);
  });
  it("wraps the real functions: cal-ingest, and the health scans that use the cron() helper", () => {
    const real = new Inngest({ id: "test-app", isDev: true });
    const { tracker } = memoryTracker();
    const t = withFailureTracking(real, tracker);
    const fn = calIngestFunction(t, { listConnections: async () => [], enabledLanes: () => ["PKG"] }) as unknown as { opts: Record<string, unknown> };
    expect(typeof fn.opts.onFailure).toBe("function");
    expect(fn.opts.retries).toBe(2);
    const scans = connHealthFunctions(t, { enabledLanes: () => ["PKG"], listConnectionIds: async () => [], check: vi.fn(), markReconnectNotified: vi.fn() } as never, { enabledLanes: () => ["PKG"], listConnectionIds: async () => [], renew: vi.fn() } as never) as unknown as { opts: Record<string, unknown> }[];
    const flags = scans.map((s) => [s.opts.id, typeof s.opts.onFailure]);
    expect(flags).toEqual([["conn-token-health-scan", "function"], ["conn-token-health", "undefined"], ["conn-subscriptions-renew-scan", "function"], ["conn-subscriptions-renew", "undefined"]]);
  });
  it("other client methods keep working through the wrapper", () => {
    const { client } = fakeClient();
    expect((withFailureTracking(client, memoryTracker().tracker) as unknown as { other: () => string }).other()).toBe("x");
  });
});

describe("counting, reset and the alert", () => {
  it("counts a failed run once, alerts exactly once at 3 with ids and a code only, and a success resets", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client, registered } = fakeClient();
    const m = memoryTracker();
    withFailureTracking(client, m.tracker).createFunction(cron as never, (async () => ({ ok: true })) as never);
    const { options, handler } = registered[0] as Registered;
    const fail = (e: unknown) => (options.onFailure as (c: unknown) => Promise<void>)(failureCtx({}, e));
    await fail(new Error("cal.ingest_delta: 1 lane(s) could not be listed"));
    await fail(new Error("secret provider text jane@example.test"));
    expect(err).not.toHaveBeenCalled();
    await fail(new Error("anything"));
    expect(err).toHaveBeenCalledTimes(1);
    const [msg, fields] = err.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain("3 times in a row");
    expect(fields).toEqual({ laneId: "PKG", functionId: "cal-ingest-delta", connectionId: "", code: "failed", failures: 3 });
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/jane|secret/);
    await fail(new Error("again"));
    expect(err).toHaveBeenCalledTimes(1); // once per streak
    expect(m.rows.get(m.key("PKG", "cal-ingest-delta", ""))).toMatchObject({ n: 4, alerted: true });
    await expect(handler({ event: { data: {} } })).resolves.toEqual({ ok: true }); // a run that completes
    expect(m.rows.get(m.key("PKG", "cal-ingest-delta", ""))).toMatchObject({ n: 0, alerted: false });
    await fail(new Error("x"));
    await fail(new Error("x"));
    expect(err).toHaveBeenCalledTimes(1); // the new streak is at 2
    await fail(new Error("x"));
    expect(err).toHaveBeenCalledTimes(2); // a new streak alerts again
    err.mockRestore();
  });

  it("a cross-lane cron records against every enabled lane, and only enabled ones", async () => {
    const { client, registered } = fakeClient();
    const m = memoryTracker(["PKG", "APK", "PKG", "bad lane"]);
    withFailureTracking(client, m.tracker).createFunction(cron as never, (async () => "ok") as never);
    await ((registered[0] as Registered).options.onFailure as (c: unknown) => Promise<void>)(failureCtx({}, new Error("x")));
    expect([...m.rows.keys()].sort()).toEqual(["APK|cal-ingest-delta|", "PKG|cal-ingest-delta|"]);
  });

  it("the tracker's own failures never break the run or the failure handler", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client, registered } = fakeClient();
    const bad = memoryTracker(["PKG"], { recordFailure: async () => { throw new Error("db password=hunter2"); }, recordSuccess: async () => { throw new Error("db down"); } });
    withFailureTracking(client, bad.tracker).createFunction(cron as never, (async () => "done") as never);
    const { options, handler } = registered[0] as Registered;
    await expect((options.onFailure as (c: unknown) => Promise<void>)(failureCtx({}, new Error("x")))).resolves.toBeUndefined();
    await expect(handler({ event: { data: {} } })).resolves.toBe("done");
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/hunter2/);
    err.mockRestore();
  });

  it("a handler that throws is not marked as a success (the failure is Inngest's to retry and then report)", async () => {
    const { client, registered } = fakeClient();
    const m = memoryTracker();
    const success = vi.spyOn(m.tracker, "recordSuccess");
    withFailureTracking(client, m.tracker).createFunction(cron as never, (async () => { throw new Error("boom"); }) as never);
    await expect((registered[0] as Registered).handler({ event: { data: {} } })).rejects.toThrow("boom");
    expect(success).not.toHaveBeenCalled();
  });
});

describe("conn.sync runs started by the schedule", () => {
  const sched = (streams?: string[]) => ({ laneId: "PKG", connectionId: CONN, trigger: "schedule", ...(streams ? { streams } : {}) });
  const setup = (lanes?: string[]) => {
    const { client, registered } = fakeClient();
    const m = memoryTracker(lanes);
    withFailureTracking(client, m.tracker).createFunction({ id: "conn-sync", triggers: [{ event: "conn/sync.requested" }] } as never, (async (ctx: { event: { data: { connectionId: string } } }) => (ctx.event.data.connectionId === "skip" ? { ok: true, skipped: "already_running" } : { ok: true })) as never);
    const { options, handler } = registered[0] as Registered;
    return { m, handler, fail: (orig: unknown, e: unknown) => (options.onFailure as (c: unknown) => Promise<void>)(failureCtx(orig, e)) };
  };

  it("counts per lane, connection and STREAM: a failing calendar is not reset by the mail run that succeeds between its failures", async () => {
    const { m, handler, fail } = setup();
    await fail(sched(["calendar"]), new Error("conn.sync failed: forbidden"));
    await handler({ event: { data: sched(["mail"]) } }); // mail succeeds
    await fail(sched(["calendar"]), new Error("conn.sync failed: forbidden"));
    await handler({ event: { data: sched(["mail"]) } });
    await fail(sched(["calendar"]), new Error("conn.sync failed: forbidden"));
    expect(m.rows.get(m.key("PKG", "conn-sync.calendar", CONN))).toMatchObject({ n: 3, alerted: true, code: "forbidden" });
    expect(m.rows.get(m.key("PKG", "conn-sync.mail", CONN))).toBeUndefined();
  });

  it("a scheduled run for both streams uses the plain function id", async () => {
    const { m, fail } = setup();
    await fail(sched(), new Error("conn.sync failed: transient"));
    expect([...m.rows.keys()]).toEqual([`PKG|conn-sync|${CONN}`]);
  });

  it("manual, webhook and connect runs are not tracked; nor is a lane this deployment does not serve or a forged event", async () => {
    const { m, handler, fail } = setup();
    for (const trigger of ["manual", "webhook", "connect"]) {
      await fail({ ...sched(), trigger }, new Error("conn.sync failed: transient"));
      await handler({ event: { data: { ...sched(), trigger } } });
    }
    await fail({ ...sched(), laneId: "APK" }, new Error("x"));
    await fail({ ...sched(), connectionId: "not-a-uuid" }, new Error("x"));
    await fail({ ...sched(), laneId: "pkg" }, new Error("x"));
    await fail(undefined, new Error("x"));
    expect(m.rows.size).toBe(0);
  });

  it("a skipped run (already running) neither counts nor resets", async () => {
    const { m, handler, fail } = setup();
    await fail(sched(["mail"]), new Error("conn.sync failed: transient"));
    await handler({ event: { data: { ...sched(["mail"]), connectionId: "skip" } } });
    expect(m.rows.get(m.key("PKG", "conn-sync.mail", CONN))).toMatchObject({ n: 1 });
  });

  it("lanes stay apart: another lane's connection has its own row", async () => {
    const { m, fail } = setup(["PKG", "APK"]);
    await fail(sched(["mail"]), new Error("conn.sync failed: transient"));
    await fail({ ...sched(["mail"]), laneId: "APK", connectionId: "00000000-0000-4000-8000-0000000000b2" }, new Error("conn.sync failed: transient"));
    expect([...m.rows.keys()].sort()).toEqual([`APK|conn-sync.mail|00000000-0000-4000-8000-0000000000b2`, `PKG|conn-sync.mail|${CONN}`]);
  });
});
