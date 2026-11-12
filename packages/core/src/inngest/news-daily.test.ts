import { Inngest } from "inngest";
import { describe, expect, it } from "vitest";
import { handleNewsDaily, isNewsTimeReached, NEWS_DAILY_CRON, newsDailyFunction } from "./news-daily";

const step = { run: async <T,>(_id: string, fn: () => T | Promise<T>) => fn() };

describe("news.daily", () => {
  it("is a 15-minute cron function", () => {
    const fn = newsDailyFunction(new Inngest({ id: "test-app", isDev: true }), { enabledLanes: () => [], due: async () => false, run: async () => "x" }) as unknown as { opts: Record<string, unknown> };
    expect(fn.opts.id).toBe("news-daily");
    expect(NEWS_DAILY_CRON).toBe("*/15 * * * *");
  });
  it("runs only lanes that are due; a lane that is not configured does nothing (no run call)", async () => {
    const ran: string[] = [];
    const deps = {
      enabledLanes: () => ["PKG", "APK"],
      due: async (l: string) => l === "PKG",
      run: async (l: string) => {
        ran.push(l);
        return "fetched";
      },
    };
    await expect(handleNewsDaily(deps, step, new Date())).resolves.toEqual({ lanes: 2, outcomes: { PKG: "fetched", APK: "skipped:not_due" } });
    expect(ran).toEqual(["PKG"]);
  });
  it("per-lane isolation: one lane failing does not stop the others; the tick then fails with lane ids only", async () => {
    const ran: string[] = [];
    const deps = {
      enabledLanes: () => ["PKG", "APK", "bad lane", "PKG"],
      due: async () => true,
      run: async (l: string) => {
        if (l === "PKG") throw new Error("db down: secret detail");
        ran.push(l);
        return "fetched";
      },
    };
    await expect(handleNewsDaily(deps, step, new Date())).rejects.toThrow("news.daily: failed for lane(s) PKG");
    await expect(handleNewsDaily(deps, step, new Date())).rejects.not.toThrow(/secret detail/);
    expect(ran).toContain("APK");
  });
  it("a failure to read the due state fails that lane only", async () => {
    const deps = { enabledLanes: () => ["PKG", "APK"], due: async (l: string) => { if (l === "PKG") throw new Error("x"); return true; }, run: async () => "fetched" };
    await expect(handleNewsDaily(deps, step, new Date())).rejects.toThrow("lane(s) PKG");
  });
  it("the time is reached from hh:mm New York on, DST-aware, and resets at New York midnight", () => {
    expect(isNewsTimeReached("06:00", new Date("2026-11-11T10:59:00Z"))).toBe(false); // 05:59 EST
    expect(isNewsTimeReached("06:00", new Date("2026-11-11T11:00:00Z"))).toBe(true); // 06:00 EST
    expect(isNewsTimeReached("06:00", new Date("2026-07-08T10:00:00Z"))).toBe(true); // 06:00 EDT
    expect(isNewsTimeReached("06:00", new Date("2026-07-08T09:59:00Z"))).toBe(false);
    expect(isNewsTimeReached("06:00", new Date("2026-11-12T04:59:00Z"))).toBe(true); // 23:59 EST: still today
    expect(isNewsTimeReached("06:00", new Date("2026-11-12T05:00:00Z"))).toBe(false); // 00:00 EST next day
    expect(isNewsTimeReached("6:00", new Date("2026-11-11T12:00:00Z"))).toBe(false);
    expect(isNewsTimeReached("24:00", new Date("2026-11-11T12:00:00Z"))).toBe(false);
  });
});
