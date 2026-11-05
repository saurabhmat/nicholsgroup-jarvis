// cal.ingest_delta (T-130): cron, fan-out per enabled lane, ids only, deterministic event ids, lane failure isolation,
// and that the events it sends are the ones conn.sync accepts (forged or invalid ones are refused).
import { Inngest, NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import {
  CAL_INGEST_CADENCE_MS,
  CAL_INGEST_CRON,
  CAL_INGEST_RETRIES,
  calIngestEventId,
  calIngestFunction,
  calIngestSlot,
  handleCalIngest,
  planCalIngest,
  type CalIngestDeps,
} from "./cal-ingest";
import { handleConnSync } from "./conn-sync";
import { connSyncRequested } from "./events";

const A = "00000000-0000-4000-8000-000000000a01";
const B = "00000000-0000-4000-8000-000000000a02";
const C = "00000000-0000-4000-8000-000000000a03";

const deps = (over: Partial<CalIngestDeps> = {}): CalIngestDeps & { listConnections: ReturnType<typeof vi.fn> } => ({
  enabledLanes: () => ["PKG"],
  ...over,
  listConnections: vi.fn(over.listConnections ?? (async () => [A, B])),
});

describe("config", () => {
  it("runs every 15 minutes, with retries, as the cal-ingest-delta function", () => {
    expect(CAL_INGEST_CRON).toBe("*/15 * * * *");
    expect(CAL_INGEST_CADENCE_MS).toBe(15 * 60_000);
    const fn = calIngestFunction(new Inngest({ id: "test-app", isDev: true }), deps()) as unknown as { opts: Record<string, unknown> };
    const opts = JSON.parse(JSON.stringify(fn.opts)) as Record<string, unknown>;
    expect(opts.id).toBe("cal-ingest-delta");
    expect(opts.triggers).toEqual([{ cron: CAL_INGEST_CRON }]);
    expect(opts.retries).toBe(CAL_INGEST_RETRIES);
  });
});

describe("event ids", () => {
  it("are deterministic per connection and tick, and differ across ticks and connections", () => {
    const t = Date.parse("2026-11-05T12:07:00Z");
    expect(calIngestSlot(t)).toBe(calIngestSlot(Date.parse("2026-11-05T12:14:59Z")));
    expect(calIngestSlot(Date.parse("2026-11-05T12:15:00Z"))).toBe(calIngestSlot(t) + 1);
    expect(calIngestEventId(A, calIngestSlot(t))).toBe(calIngestEventId(A, calIngestSlot(t)));
    expect(calIngestEventId(A, 1)).not.toBe(calIngestEventId(A, 2));
    expect(calIngestEventId(A, 1)).not.toBe(calIngestEventId(B, 1));
  });
  it("refuse an unusable schedule time", () => {
    for (const bad of [Number.NaN, -1, Infinity]) expect(() => calIngestSlot(bad)).toThrow(NonRetriableError);
  });
});

describe("planCalIngest", () => {
  it("lists only enabled lanes, once each, and plans one send per connection", async () => {
    const d = deps({ enabledLanes: () => ["PKG", "PKG", "APK"], listConnections: async (lane) => (lane === "PKG" ? [A, A, B] : [C]) });
    const plan = await planCalIngest(d);
    expect(d.listConnections.mock.calls.map((c) => c[0])).toEqual(["PKG", "APK"]);
    expect(plan.sends).toEqual([
      { laneId: "PKG", connectionId: A },
      { laneId: "PKG", connectionId: B },
      { laneId: "APK", connectionId: C },
    ]);
    expect(plan.failedLanes).toEqual([]);
  });

  it("sends nothing for a lane that is not enabled (never lists it)", async () => {
    const d = deps({ enabledLanes: () => [] });
    await expect(planCalIngest(d)).resolves.toEqual({ sends: [], failedLanes: [] });
    expect(d.listConnections).not.toHaveBeenCalled();
  });

  it("a lane that fails to list does not block the others, and is reported by id only", async () => {
    const d = deps({
      enabledLanes: () => ["PKG", "APK"],
      listConnections: async (lane) => {
        if (lane === "PKG") throw new Error("secret detail postgres://user:pw@host");
        return [C];
      },
    });
    const plan = await planCalIngest(d);
    expect(plan).toEqual({ sends: [{ laneId: "APK", connectionId: C }], failedLanes: ["PKG"] });
    expect(JSON.stringify(plan)).not.toContain("secret");
  });

  it("drops anything that is not a connection uuid", async () => {
    const plan = await planCalIngest(deps({ listConnections: async () => [A, "not-a-uuid", "../x"] }));
    expect(plan.sends).toEqual([{ laneId: "PKG", connectionId: A }]);
  });
});

describe("what is sent is what conn.sync accepts", () => {
  it("the fan-out event is a valid conn/sync.requested with trigger schedule and the tick id", async () => {
    const e = connSyncRequested.create({ laneId: "PKG", connectionId: A, trigger: "schedule" }, { id: calIngestEventId(A, 7) });
    expect(e.name).toBe("conn/sync.requested");
    expect(e.id).toBe("cal-ingest:" + A + ":7");
    await expect(e.validate()).resolves.toBeUndefined();
    expect(e.data).toEqual({ laneId: "PKG", connectionId: A, trigger: "schedule" });
  });

  it("forged or invalid events are refused by conn.sync without running a sync", async () => {
    const runSync = vi.fn();
    const d = { runSync, enabledLanes: () => ["PKG"] };
    const bad = [
      { laneId: "PKG", connectionId: A },
      { laneId: "PKG", connectionId: A, trigger: "cron" },
      { laneId: "PKG", connectionId: "x", trigger: "schedule" },
      { laneId: "pkg", connectionId: A, trigger: "schedule" },
      { laneId: "PKG", connectionId: A, trigger: "schedule", token: "t" },
    ];
    for (const b of bad) await expect(handleConnSync(d, b as never, null)).rejects.toBeInstanceOf(NonRetriableError);
    await expect(handleConnSync(d, { laneId: "APK", connectionId: A, trigger: "schedule" }, null)).resolves.toEqual({ ok: true, skipped: "lane_not_served" });
    expect(runSync).not.toHaveBeenCalled();
  });
});

describe("handleCalIngest", () => {
  const TS = Date.parse("2026-11-05T12:15:00Z");
  const fakeStep = () => {
    const sent: { id: string; events: { name: string; id?: string; data: unknown }[] }[] = [];
    const step = {
      run: async <T,>(_id: string, fn: () => T | Promise<T>) => fn(),
      sendEvent: async (id: string, events: { name: string; id?: string; data: unknown }[]) => { sent.push({ id, events }); },
    };
    return { step: step as never, sent };
  };

  it("sends one scheduled conn/sync.requested per connection with the tick id", async () => {
    const { step, sent } = fakeStep();
    const out = await handleCalIngest(deps(), TS, step);
    const slot = calIngestSlot(TS);
    expect(out).toEqual({ lanes: 1, connections: 2, slot });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events.map((e) => [e.name, e.id, e.data])).toEqual([
      ["conn/sync.requested", calIngestEventId(A, slot), { laneId: "PKG", connectionId: A, trigger: "schedule" }],
      ["conn/sync.requested", calIngestEventId(B, slot), { laneId: "PKG", connectionId: B, trigger: "schedule" }],
    ]);
  });

  it("sends nothing when there is nothing to sync", async () => {
    const { step, sent } = fakeStep();
    await expect(handleCalIngest(deps({ listConnections: async () => [] }), TS, step)).resolves.toMatchObject({ connections: 0 });
    expect(sent).toHaveLength(0);
  });

  it("sends the healthy lanes first, then fails the run when a lane could not be listed", async () => {
    const { step, sent } = fakeStep();
    const d = deps({ enabledLanes: () => ["PKG", "APK"], listConnections: async (l) => { if (l === "PKG") throw new Error("x"); return [C]; } });
    await expect(handleCalIngest(d, TS, step)).rejects.toBeInstanceOf(NonRetriableError);
    expect(sent[0]?.events).toHaveLength(1);
  });

  it("refuses a missing schedule time instead of guessing a tick", async () => {
    const { step, sent } = fakeStep();
    for (const bad of [undefined, "2026", null]) await expect(handleCalIngest(deps(), bad, step)).rejects.toBeInstanceOf(NonRetriableError);
    expect(sent).toHaveLength(0);
  });
});
