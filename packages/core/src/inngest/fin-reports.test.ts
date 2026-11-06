// fin.qbo_reports (T-052): nightly schedule, per-connection worker, lane checks, retries, ids only.
import { Inngest, NonRetriableError, RetryAfterError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { finQboReportsRequested, LANE_EVENTS } from "./events";
import {
  FIN_REPORTS_CONCURRENCY,
  FIN_REPORTS_CRON,
  FIN_REPORTS_RETRIES,
  finQboReportsFunctions,
  finReportsEventId,
  handleFinReports,
  handleFinReportsSchedule,
  planFinReports,
  type FinQboReportsDeps,
  type FinQboReportsResult,
} from "./fin-reports";

const A = "00000000-0000-4000-8000-000000000a01";
const B = "00000000-0000-4000-8000-000000000a02";
const OK: FinQboReportsResult = { ok: true, skipped: null, stored: ["pnl"], excludedRows: 0 };

const deps = (over: Partial<FinQboReportsDeps> = {}) => ({
  enabledLanes: () => ["PKG"] as readonly string[],
  ...over,
  listConnections: vi.fn(over.listConnections ?? (async () => [A, B] as readonly string[])),
  runReports: vi.fn(over.runReports ?? (async (): Promise<FinQboReportsResult> => OK)),
});
const step = () => {
  const sent: { id: string; events: ReturnType<typeof finQboReportsRequested.create>[] }[] = [];
  return { sent, api: { run: async <T>(_id: string, fn: () => T | Promise<T>) => fn(), sendEvent: async (id: string, events: ReturnType<typeof finQboReportsRequested.create>[]) => void sent.push({ id, events }) } };
};

describe("config", () => {
  it("is a nightly 02:00 America/New_York schedule and a per-connection worker (concurrency 1 per connection)", () => {
    expect(FIN_REPORTS_CRON).toBe("TZ=America/New_York 0 2 * * *");
    expect(FIN_REPORTS_CONCURRENCY).toEqual({ key: "event.data.connectionId", limit: 1 });
    const fns = finQboReportsFunctions(new Inngest({ id: "test-app", isDev: true }), deps()) as unknown as { opts: Record<string, unknown> }[];
    const [schedule, worker] = fns.map((f) => JSON.parse(JSON.stringify(f.opts)) as Record<string, unknown>);
    expect(schedule?.id).toBe("fin-qbo-reports-schedule");
    expect(schedule?.triggers).toEqual([{ cron: FIN_REPORTS_CRON }]);
    expect(worker?.id).toBe("fin-qbo-reports-connection");
    expect(worker?.retries).toBe(FIN_REPORTS_RETRIES);
    expect(worker?.concurrency).toEqual(FIN_REPORTS_CONCURRENCY);
    expect(JSON.stringify(worker?.triggers)).toContain("fin/qbo-reports.requested");
  });

  it("the event requires a lane id, a connection uuid and a known trigger, and takes nothing else", async () => {
    expect(LANE_EVENTS).toContain(finQboReportsRequested);
    const make = (d: unknown) => (finQboReportsRequested.create as (d: unknown) => { validate(): Promise<unknown> })(d);
    await expect(make({ laneId: "PKG", connectionId: A, trigger: "schedule" }).validate()).resolves.toBeUndefined();
    for (const bad of [{ connectionId: A, trigger: "schedule" }, { laneId: "PKG", connectionId: "x", trigger: "schedule" }, { laneId: "PKG", connectionId: A, trigger: "cron" }, { laneId: "PKG", connectionId: A, trigger: "manual", body: "x" }, { laneId: "pkg", connectionId: A, trigger: "manual" }]) {
      await expect(make(bad).validate(), JSON.stringify(bad)).rejects.toThrow();
    }
  });
});

describe("schedule", () => {
  it("lists enabled lanes once each and sends one event per usable QuickBooks connection with a deterministic id", async () => {
    const d = deps({ enabledLanes: () => ["PKG", "PKG", "APK"], listConnections: async (l: string) => (l === "PKG" ? [A, A, B] : [A]) });
    const s = step();
    const t = Date.parse("2026-11-06T07:00:00Z");
    expect(await handleFinReportsSchedule(d, t, s.api)).toEqual({ lanes: 2, connections: 3 });
    expect(d.listConnections.mock.calls.map((c) => c[0])).toEqual(["PKG", "APK"]);
    const events = s.sent[0]?.events ?? [];
    expect(events.map((e) => e.data)).toEqual([
      { laneId: "PKG", connectionId: A, trigger: "schedule" },
      { laneId: "PKG", connectionId: B, trigger: "schedule" },
      { laneId: "APK", connectionId: A, trigger: "schedule" },
    ]);
    expect(events[0]?.id).toBe(finReportsEventId(A, t));
    // the same night (a retry, a double cron) gets the same id; the next night differs
    expect(finReportsEventId(A, t)).toBe(finReportsEventId(A, Date.parse("2026-11-06T23:00:00Z")));
    expect(finReportsEventId(A, t)).not.toBe(finReportsEventId(A, Date.parse("2026-11-07T07:00:00Z")));
    expect(finReportsEventId(A, t)).not.toBe(finReportsEventId(B, t));
  });

  it("a lane that cannot be listed is skipped, the others are sent, then the run fails visibly (not retried)", async () => {
    const d = deps({ enabledLanes: () => ["APK", "PKG"], listConnections: async (l: string) => { if (l === "APK") throw new Error("db text SECRET"); return [A]; } });
    const s = step();
    const err = (await handleFinReportsSchedule(d, 1_000_000, s.api).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(NonRetriableError);
    expect(err.message).not.toContain("SECRET");
    expect(s.sent[0]?.events.map((e) => e.data.laneId)).toEqual(["PKG"]);
  });

  it("drops a non-uuid id, sends nothing for no connections, and refuses an invalid time before listing", async () => {
    const d = deps({ listConnections: async () => ["nope", A] as readonly string[] });
    const s = step();
    await handleFinReportsSchedule(d, 5_000_000, s.api);
    expect(s.sent[0]?.events).toHaveLength(1);
    const none = step();
    await handleFinReportsSchedule(deps({ listConnections: async () => [] }), 5_000_000, none.api);
    expect(none.sent).toEqual([]);
    const d2 = deps();
    for (const bad of ["x", Number.NaN, -1, undefined]) await expect(handleFinReportsSchedule(d2, bad, step().api)).rejects.toThrow(NonRetriableError);
    expect(d2.listConnections).not.toHaveBeenCalled();
  });

  it("planFinReports lists only enabled lanes", async () => {
    const d = deps({ enabledLanes: () => [] });
    expect(await planFinReports(d)).toEqual({ sends: [], failedLanes: [] });
    expect(d.listConnections).not.toHaveBeenCalled();
  });
});

describe("worker", () => {
  const data = { laneId: "PKG", connectionId: A, trigger: "schedule" };

  it("runs the pull for the event's lane and connection", async () => {
    const d = deps();
    expect(await handleFinReports(d, data)).toEqual(OK);
    expect(d.runReports).toHaveBeenCalledWith("PKG", A);
  });

  it("validates the event again and refuses a lane this deployment does not serve (nothing runs)", async () => {
    const d = deps({ enabledLanes: () => ["PKG"] });
    expect(await handleFinReports(d, { ...data, laneId: "APK" })).toEqual({ ok: true, skipped: "lane_not_served" });
    for (const bad of [{}, { laneId: "PKG" }, { ...data, connectionId: "x" }, { ...data, extra: 1 }, { ...data, trigger: "other" }]) {
      await expect(handleFinReports(d, bad as never), JSON.stringify(bad)).rejects.toThrow(NonRetriableError);
    }
    expect(d.runReports).not.toHaveBeenCalled();
  });

  it("passes a skip through; permanent failures stop at once; transient ones are retried (honouring retry-after)", async () => {
    const skip: FinQboReportsResult = { ok: true, skipped: "connection_not_usable" };
    expect(await handleFinReports(deps({ runReports: async () => skip }), data)).toEqual(skip);
    const fail = (retryable: boolean, retryAfterSeconds: number | null): FinQboReportsResult => ({ ok: false, retryable, retryAfterSeconds, errorKind: "x_kind", message: "m SECRET", stored: [] });
    const permanent = (await handleFinReports(deps({ runReports: async () => fail(false, null) }), data).catch((e: unknown) => e)) as Error;
    expect(permanent).toBeInstanceOf(NonRetriableError);
    expect(permanent.message).toBe("fin.qbo_reports failed: x_kind");
    const later = await handleFinReports(deps({ runReports: async () => fail(true, 7200) }), data).catch((e: unknown) => e);
    expect(later).toBeInstanceOf(RetryAfterError);
    const plain = await handleFinReports(deps({ runReports: async () => fail(true, null) }), data).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(Error);
    expect(plain).not.toBeInstanceOf(NonRetriableError);
    expect((plain as Error).message).not.toContain("SECRET");
  });
});
