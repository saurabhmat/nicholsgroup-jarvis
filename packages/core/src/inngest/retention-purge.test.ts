// retention.purge Inngest functions (T-042): cron, concurrency, retries, lane check, failure translation, fan-out.
import { NonRetriableError, Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { retentionPurgeRequested, LANE_EVENTS } from "./events";
import {
  handleRetentionPurge,
  RETENTION_CRON,
  RETENTION_PURGE_CONCURRENCY,
  RETENTION_PURGE_RETRIES,
  RETENTION_SCHEDULE_RETRIES,
  retentionPurgeFunctions,
  type RetentionPurgeDeps,
  type RetentionPurgeResult,
} from "./retention-purge";

const okResult = (laneId: string): RetentionPurgeResult => ({ laneId, ok: true, results: [{ table: "comms.message_index", class: "comms", deleted: 2 }], emptyClasses: ["conversations"] });
const deps = (over: Partial<RetentionPurgeDeps> = {}): RetentionPurgeDeps & { purgeLane: ReturnType<typeof vi.fn> } => ({
  enabledLanes: () => ["PKG"],
  ...over,
  purgeLane: vi.fn(over.purgeLane ?? (async (lane: string) => okResult(lane))),
});

describe("function config", () => {
  const fns = retentionPurgeFunctions(new Inngest({ id: "test-app", isDev: true }), deps()) as unknown as { opts: Record<string, unknown> }[];
  const opts = fns.map((f) => JSON.parse(JSON.stringify(f.opts)) as Record<string, unknown>);

  it("schedule: daily at 03:00 America/New_York (off hours), with retries", () => {
    expect(RETENTION_CRON).toBe("TZ=America/New_York 0 3 * * *");
    const o = opts.find((x) => x.id === "retention-purge-schedule");
    expect(o?.triggers).toEqual([{ cron: RETENTION_CRON }]);
    expect(o?.retries).toBe(RETENTION_SCHEDULE_RETRIES);
  });

  it("worker: per-lane concurrency key, one at a time, retries, triggered by the typed event", () => {
    expect(RETENTION_PURGE_CONCURRENCY).toEqual({ key: "event.data.laneId", limit: 1 });
    const o = opts.find((x) => x.id === "retention-purge-lane");
    expect(o?.concurrency).toEqual(RETENTION_PURGE_CONCURRENCY);
    expect(o?.retries).toBe(RETENTION_PURGE_RETRIES);
    expect(RETENTION_PURGE_RETRIES).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(o?.triggers)).toContain("retention/purge.requested");
  });

  it("the event requires a lane and is registered with the lane events", async () => {
    expect(LANE_EVENTS).toContain(retentionPurgeRequested);
    expect((await retentionPurgeRequested.schema["~standard"].validate({})).issues).toBeDefined();
    expect((await retentionPurgeRequested.schema["~standard"].validate({ laneId: "PKG", x: 1 })).issues).toBeDefined();
    expect((await retentionPurgeRequested.schema["~standard"].validate({ laneId: "PKG" })).issues).toBeUndefined();
  });
});

describe("handleRetentionPurge", () => {
  it("runs the lane's purge and returns counts", async () => {
    const d = deps();
    await expect(handleRetentionPurge(d, { laneId: "PKG" })).resolves.toEqual(okResult("PKG"));
    expect(d.purgeLane).toHaveBeenCalledWith("PKG");
  });

  it("refuses malformed events without purging, and skips lanes this deployment does not serve", async () => {
    const d = deps();
    for (const bad of [{}, { laneId: "pkg;" }, { laneId: "PKG", extra: 1 }]) {
      await expect(handleRetentionPurge(d, bad as never)).rejects.toBeInstanceOf(NonRetriableError);
    }
    await expect(handleRetentionPurge(d, { laneId: "APK" })).resolves.toEqual({ ok: true, skipped: "lane_not_served" });
    expect(d.purgeLane).not.toHaveBeenCalled();
  });

  it("a partly failed lane throws (so Inngest retries) with a message that names counts only", async () => {
    const failed: RetentionPurgeResult = { laneId: "PKG", ok: false, results: [{ table: "comms.message_index", class: "comms", error: "purge_failed" }, { table: "cal.event_index", class: "calendar", deleted: 1 }], emptyClasses: [] };
    const err = await handleRetentionPurge(deps({ purgeLane: vi.fn(async () => failed) }), { laneId: "PKG" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetriableError);
    expect((err as Error).message).toBe("retention.purge failed for 1 table(s)");
  });

  it("one lane failing does not block another (independent runs)", async () => {
    const d = deps({
      enabledLanes: () => ["PKG", "APK"],
      purgeLane: vi.fn(async (lane: string): Promise<RetentionPurgeResult> => {
        if (lane === "PKG") throw new Error("settings unreadable");
        return okResult(lane);
      }),
    });
    const [a, b] = await Promise.allSettled([handleRetentionPurge(d, { laneId: "PKG" }), handleRetentionPurge(d, { laneId: "APK" })]);
    expect(a.status).toBe("rejected");
    expect(b).toMatchObject({ status: "fulfilled", value: okResult("APK") });
  });
});
