// fin.sync QuickBooks backup poll (T-090): hourly cron + per-lane interval, fan-out per usable connection, deterministic ids,
// lane failure isolation, nothing leaked; plus the normalize-skip rule and the nightly report schedule it sits beside.
import { Inngest, NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { connSyncRequested, finQboNormalizeRequested, finQboReportsRequested } from "./events";
import { FIN_REPORTS_CRON, finReportsEventId } from "./fin-reports";
import { shouldNormalizeAfterSync } from "./fin-normalize";
import { FIN_SYNC_CRON, FIN_SYNC_RETRIES, finSyncDue, finSyncEventId, finSyncFunction, finSyncHour, handleFinSync, planFinSync, type FinSyncDeps } from "./fin-sync";

const A = "00000000-0000-4000-8000-000000000b01";
const B = "00000000-0000-4000-8000-000000000b02";
const C = "00000000-0000-4000-8000-000000000b03";

const deps = (over: Partial<FinSyncDeps> = {}): FinSyncDeps & { listConnections: ReturnType<typeof vi.fn>; intervalHours: ReturnType<typeof vi.fn> } => ({
  enabledLanes: () => ["PKG"],
  ...over,
  listConnections: vi.fn(over.listConnections ?? (async () => [A, B])),
  intervalHours: vi.fn(over.intervalHours ?? (async () => 4)),
});
const at = (iso: string) => Date.parse(iso);

describe("config", () => {
  it("ticks hourly, with retries, as fin-sync-quickbooks", () => {
    expect(FIN_SYNC_CRON).toBe("0 * * * *");
    const fn = finSyncFunction(new Inngest({ id: "test-app", isDev: true }), deps()) as unknown as { opts: Record<string, unknown> };
    const opts = JSON.parse(JSON.stringify(fn.opts)) as Record<string, unknown>;
    expect(opts.id).toBe("fin-sync-quickbooks");
    expect(opts.triggers).toEqual([{ cron: FIN_SYNC_CRON }]);
    expect(opts.retries).toBe(FIN_SYNC_RETRIES);
  });
});

describe("slots", () => {
  it("default interval 4 is due at 00/04/08/12/16/20 UTC only", () => {
    const due = [...Array(24).keys()].filter((h) => finSyncDue(finSyncHour(at(`2026-11-05T${String(h).padStart(2, "0")}:00:00Z`)), 4));
    expect(due).toEqual([0, 4, 8, 12, 16, 20]);
  });
  it("hour index is stable inside the hour and event ids are deterministic per connection and hour", () => {
    expect(finSyncHour(at("2026-11-05T12:00:00Z"))).toBe(finSyncHour(at("2026-11-05T12:59:59Z")));
    expect(finSyncHour(at("2026-11-05T13:00:00Z"))).toBe(finSyncHour(at("2026-11-05T12:00:00Z")) + 1);
    expect(finSyncEventId(A, 5)).toBe(finSyncEventId(A, 5));
    expect(finSyncEventId(A, 5)).not.toBe(finSyncEventId(A, 6));
    expect(finSyncEventId(A, 5)).not.toBe(finSyncEventId(B, 5));
    expect(() => finSyncEventId("x", 5)).toThrow();
    expect(() => finSyncEventId(A, -1)).toThrow();
  });
  it("refuse a bad schedule time and any interval outside the allowed set", () => {
    for (const bad of [Number.NaN, -1, Infinity]) expect(() => finSyncHour(bad)).toThrow(NonRetriableError);
    for (const bad of [0, 5, 7, 24, -4, 1.5, "4", null, undefined]) expect(() => finSyncDue(8, bad)).toThrow();
    expect(finSyncDue(6, 1)).toBe(true);
    expect(finSyncDue(7, 6)).toBe(false);
    expect(finSyncDue(6, 6)).toBe(true);
  });
});

describe("planFinSync", () => {
  it("lists each enabled lane once, only when due, one send per usable connection", async () => {
    const d = deps({ enabledLanes: () => ["PKG", "PKG", "APK"], listConnections: async (l) => (l === "PKG" ? [A, A, B] : [C]), intervalHours: async (l) => (l === "PKG" ? 4 : 6) });
    const plan = await planFinSync(d, 8); // 8 % 4 === 0, 8 % 6 !== 0
    expect(plan).toEqual({ sends: [{ laneId: "PKG", connectionId: A }, { laneId: "PKG", connectionId: B }], failedLanes: [] });
    expect(d.listConnections.mock.calls.map((c) => c[0])).toEqual(["PKG"]);
  });
  it("lists nothing in a lane that is not enabled, and nothing off-slot", async () => {
    const off = deps({ enabledLanes: () => [] });
    await expect(planFinSync(off, 8)).resolves.toEqual({ sends: [], failedLanes: [] });
    expect(off.listConnections).not.toHaveBeenCalled();
    const d = deps();
    await expect(planFinSync(d, 9)).resolves.toEqual({ sends: [], failedLanes: [] });
    expect(d.listConnections).not.toHaveBeenCalled();
  });
  it("a lane whose list or setting fails does not block the others and leaks no error text", async () => {
    const d = deps({
      enabledLanes: () => ["PKG", "APK", "XYZ"],
      intervalHours: async (l) => {
        if (l === "XYZ") throw new Error("settings postgres://user:pw@host");
        return 4;
      },
      listConnections: async (l) => {
        if (l === "PKG") throw new Error("secret detail");
        return [C];
      },
    });
    const plan = await planFinSync(d, 8);
    expect(plan).toEqual({ sends: [{ laneId: "APK", connectionId: C }], failedLanes: ["PKG", "XYZ"] });
    expect(JSON.stringify(plan)).not.toMatch(/secret|postgres/);
  });
  it("an interval outside the allowed set fails the lane (fail closed)", async () => {
    const plan = await planFinSync(deps({ intervalHours: async () => 5 }), 10);
    expect(plan).toEqual({ sends: [], failedLanes: ["PKG"] });
  });
  it("drops anything that is not a connection uuid", async () => {
    const plan = await planFinSync(deps({ listConnections: async () => [A, "nope", "../x"] }), 8);
    expect(plan.sends).toEqual([{ laneId: "PKG", connectionId: A }]);
  });
});

describe("handleFinSync", () => {
  const TS = at("2026-11-05T12:00:00Z");
  const fakeStep = () => {
    const sent: { id: string; events: { name: string; id?: string; data: unknown }[] }[] = [];
    const step = {
      run: async <T,>(_id: string, fn: () => T | Promise<T>) => fn(),
      sendEvent: async (id: string, events: { name: string; id?: string; data: unknown }[]) => { sent.push({ id, events }); },
    };
    return { step: step as never, sent };
  };

  it("sends a scheduled conn/sync.requested per connection with the hour id, valid for conn.sync", async () => {
    const { step, sent } = fakeStep();
    const out = await handleFinSync(deps(), TS, step);
    const hour = finSyncHour(TS);
    expect(out).toEqual({ lanes: 1, connections: 2, hour });
    expect(sent[0]?.events.map((e) => [e.name, e.id, e.data])).toEqual([
      ["conn/sync.requested", finSyncEventId(A, hour), { laneId: "PKG", connectionId: A, trigger: "schedule" }],
      ["conn/sync.requested", finSyncEventId(B, hour), { laneId: "PKG", connectionId: B, trigger: "schedule" }],
    ]);
    await expect(connSyncRequested.create({ laneId: "PKG", connectionId: A, trigger: "schedule" }).validate()).resolves.toBeUndefined();
  });
  it("sends nothing off-slot", async () => {
    const { step, sent } = fakeStep();
    await expect(handleFinSync(deps(), at("2026-11-05T13:00:00Z"), step)).resolves.toMatchObject({ connections: 0 });
    expect(sent).toHaveLength(0);
  });
  it("a replayed tick sends the same ids", async () => {
    const a = fakeStep();
    const b = fakeStep();
    await handleFinSync(deps(), TS, a.step);
    await handleFinSync(deps(), TS + 59_000, b.step);
    expect(a.sent[0]?.events.map((e) => e.id)).toEqual(b.sent[0]?.events.map((e) => e.id));
    expect(a.sent[0]?.events).toHaveLength(2);
  });
  it("sends healthy lanes first, then fails (not retried) with a message without error text", async () => {
    const { step, sent } = fakeStep();
    const d = deps({ enabledLanes: () => ["PKG", "APK"], listConnections: async (l) => { if (l === "PKG") throw new Error("secret detail"); return [C]; } });
    const err = await handleFinSync(d, TS, step).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonRetriableError);
    expect((err as Error).message).toBe("fin.sync: 1 lane(s) could not be planned");
    expect(sent[0]?.events).toHaveLength(1);
  });
  it("refuses a missing or bad schedule time", async () => {
    await expect(handleFinSync(deps(), undefined, fakeStep().step)).rejects.toBeInstanceOf(NonRetriableError);
    await expect(handleFinSync(deps(), -5, fakeStep().step)).rejects.toBeInstanceOf(NonRetriableError);
  });
});

describe("shouldNormalizeAfterSync (T-056 cost note)", () => {
  it("skips a scheduled incremental run that wrote nothing", () => {
    expect(shouldNormalizeAfterSync({ trigger: "schedule", kind: "incremental", written: 0 })).toBe(false);
  });
  it("normalizes when it wrote, when full, or for any other trigger", () => {
    expect(shouldNormalizeAfterSync({ trigger: "schedule", kind: "incremental", written: 2 })).toBe(true);
    expect(shouldNormalizeAfterSync({ trigger: "schedule", kind: "full", written: 0 })).toBe(true);
    for (const trigger of ["webhook", "manual", "connect"]) expect(shouldNormalizeAfterSync({ trigger, kind: "incremental", written: 0 })).toBe(true);
  });
  it("the 00:00 UTC tick also sends one normalize per connection per day (repairs a failed follow-up after empty polls), no other tick does", async () => {
    const midnight = at("2026-11-05T00:00:00Z");
    const h = finSyncHour(midnight);
    const sent: { id: string; events: { name: string; id?: string; data: unknown }[] }[] = [];
    const step = { run: async <T,>(_i: string, fn: () => T | Promise<T>) => fn(), sendEvent: async (id: string, events: never) => { sent.push({ id, events }); } };
    await handleFinSync(deps(), midnight, step as never);
    expect(sent.map((s) => s.id)).toEqual(["fan-out", "fan-out-normalize"]);
    expect(sent[1]?.events.map((e) => [e.name, e.id, e.data])).toEqual([
      ["fin/qbo-normalize.requested", `fin-normalize:${A}:daily-${String(h / 24)}`, { laneId: "PKG", connectionId: A, trigger: "schedule" }],
      ["fin/qbo-normalize.requested", `fin-normalize:${B}:daily-${String(h / 24)}`, { laneId: "PKG", connectionId: B, trigger: "schedule" }],
    ]);
    await expect(finQboNormalizeRequested.create({ laneId: "PKG", connectionId: A, trigger: "schedule" }).validate()).resolves.toBeUndefined();
    const other: typeof sent = [];
    const step2 = { ...step, sendEvent: async (id: string, events: never) => { other.push({ id, events }); } };
    await handleFinSync(deps(), at("2026-11-05T04:00:00Z"), step2 as never);
    expect(other.map((s) => s.id)).toEqual(["fan-out"]);
  });
});

describe("nightly report pull (T-052) is the fin.qbo_reports schedule", () => {
  it("runs at 02:00 America/New_York, one id per connection per night, with the weekly_cash hook accepted", async () => {
    expect(FIN_REPORTS_CRON).toBe("TZ=America/New_York 0 2 * * *");
    const t1 = at("2026-11-05T07:00:00Z");
    expect(finReportsEventId(A, t1)).toBe(finReportsEventId(A, t1 + 60_000));
    expect(finReportsEventId(A, t1)).not.toBe(finReportsEventId(A, t1 + 86_400_000));
    await expect(finQboReportsRequested.create({ laneId: "PKG", connectionId: A, trigger: "weekly_cash" }).validate()).resolves.toBeUndefined();
  });
});
