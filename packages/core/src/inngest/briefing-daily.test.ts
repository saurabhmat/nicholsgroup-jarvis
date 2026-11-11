import { Inngest } from "inngest";
import { describe, expect, it } from "vitest";
import { BRIEFING_DAILY_CRON, briefingDailyFunction, handleBriefingDaily, isBriefingHour } from "./briefing-daily";

const step = { run: async <T,>(_id: string, fn: () => T | Promise<T>) => fn() };
const OWNER = "00000000-0000-4000-8000-000000000001";

describe("briefing.daily", () => {
  it("is an hourly cron function", () => {
    const fn = briefingDailyFunction(new Inngest({ id: "test-app", isDev: true }), { enabledLanes: () => [], dueOwners: async () => [], run: async () => "x" }) as unknown as { opts: Record<string, unknown> };
    expect(fn.opts.id).toBe("briefing-daily");
    expect(BRIEFING_DAILY_CRON).toBe("5 * * * *");
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
  it("matches the New York hour, DST-aware", () => {
    expect(isBriefingHour("07:00", new Date("2026-11-11T12:30:00Z"))).toBe(true); // EST
    expect(isBriefingHour("07:00", new Date("2026-07-11T11:30:00Z"))).toBe(true); // EDT
    expect(isBriefingHour("07:00", new Date("2026-11-11T11:30:00Z"))).toBe(false);
  });
});
