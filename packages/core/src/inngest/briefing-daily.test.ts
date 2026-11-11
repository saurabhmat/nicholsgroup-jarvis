import { Inngest } from "inngest";
import { describe, expect, it } from "vitest";
import { BRIEFING_DAILY_CRON, briefingDailyFunction, handleBriefingDaily, isBriefingDue } from "./briefing-daily";

const step = { run: async <T,>(_id: string, fn: () => T | Promise<T>) => fn() };
const OWNER = "00000000-0000-4000-8000-000000000001";

describe("briefing.daily", () => {
  it("is a 15-minute cron function", () => {
    const fn = briefingDailyFunction(new Inngest({ id: "test-app", isDev: true }), { enabledLanes: () => [], dueOwners: async () => [], run: async () => "x" }) as unknown as { opts: Record<string, unknown> };
    expect(fn.opts.id).toBe("briefing-daily");
    expect(BRIEFING_DAILY_CRON).toBe("*/15 * * * *");
  });
  it("runs only due owners, keeps going after a failure, then fails with lane ids only", async () => {
    const ran: string[] = [];
    const deps = {
      enabledLanes: () => ["PKG", "APK", "bad lane"],
      dueOwners: async (l: string) => (l === "PKG" ? [OWNER, "not-a-uuid"] : l === "APK" ? [OWNER] : []),
      run: async (l: string) => {
        if (l === "APK") throw new Error("model down");
        ran.push(l);
        return "id";
      },
    };
    await expect(handleBriefingDaily(deps, step, new Date())).rejects.toThrow("briefing.daily: failed for lane(s) APK");
    expect(ran).toEqual(["PKG"]);
  });
  it("nothing is due when the schedule is off (dueOwners returns [])", async () => {
    await expect(handleBriefingDaily({ enabledLanes: () => ["PKG"], dueOwners: async () => [], run: async () => "x" }, step, new Date())).resolves.toEqual({ lanes: 1, prepared: 0 });
  });
  const WEEKDAYS = [1, 2, 3, 4, 5];
  it("06:30 New York, DST-aware: due in the 06:30 tick only", () => {
    expect(isBriefingDue("06:30", WEEKDAYS, new Date("2026-11-11T11:30:00Z"))).toBe(true); // Wed 06:30 EST
    expect(isBriefingDue("06:30", WEEKDAYS, new Date("2026-07-08T10:30:00Z"))).toBe(true); // Wed 06:30 EDT
    expect(isBriefingDue("06:30", WEEKDAYS, new Date("2026-11-11T11:15:00Z"))).toBe(false); // 06:15 tick
    expect(isBriefingDue("06:30", WEEKDAYS, new Date("2026-11-11T11:45:00Z"))).toBe(false); // 06:45 tick
    expect(isBriefingDue("06:30", WEEKDAYS, new Date("2026-11-11T10:30:00Z"))).toBe(false); // 05:30 EST
  });
  it("a time between ticks runs at the next tick, once", () => {
    const ticks = ["11:30", "11:45", "12:00"].map((t) => isBriefingDue("06:40", WEEKDAYS, new Date(`2026-11-11T${t}:00Z`)));
    expect(ticks).toEqual([false, true, false]);
  });
  it("Mon-Fri by the New York date (not UTC)", () => {
    expect(isBriefingDue("06:30", WEEKDAYS, new Date("2026-11-14T11:30:00Z"))).toBe(false); // Sat
    expect(isBriefingDue("06:30", WEEKDAYS, new Date("2026-11-15T11:30:00Z"))).toBe(false); // Sun
    expect(isBriefingDue("06:30", WEEKDAYS, new Date("2026-11-16T11:30:00Z"))).toBe(true); // Mon
    // 23:00 Fri in New York is already Saturday in UTC: a Friday 23:00 briefing still runs.
    expect(isBriefingDue("23:00", WEEKDAYS, new Date("2026-11-14T04:00:00Z"))).toBe(true);
    expect(isBriefingDue("06:30", [0, 6], new Date("2026-11-14T11:30:00Z"))).toBe(true);
  });
  it("a malformed time is never due", () => {
    expect(isBriefingDue("6:30", WEEKDAYS, new Date("2026-11-11T11:30:00Z"))).toBe(false);
    expect(isBriefingDue("24:00", WEEKDAYS, new Date("2026-11-11T11:30:00Z"))).toBe(false);
  });
});
