// How Messages draws times (T-283): America/New_York (rule 11), no clock read inside the functions.
import { describe, expect, it } from "vitest";
import { clockTime, dayKey, dayLabel, fullTime, listTime } from "./teams-format";

describe("Messages times (ET)", () => {
  it("clock time, full time and day are New York time, across the daylight-saving change", () => {
    expect(clockTime("2026-11-21T20:07:00Z")).toBe("3:07 PM"); // EST (UTC-5)
    expect(clockTime("2026-07-21T19:07:00Z")).toBe("3:07 PM"); // EDT (UTC-4)
    expect(fullTime("2026-11-21T20:07:00Z")).toBe("Nov 21, 2026, 3:07 PM ET");
    expect(dayKey("2026-11-22T03:30:00Z")).toBe("2026-11-21"); // still the 21st in New York
    expect(dayLabel("2026-11-21T20:07:00Z")).toBe("Saturday, November 21, 2026");
  });

  it("the list time: today the time, the last six days the weekday, earlier the date (with the year when it is not this year)", () => {
    const now = Date.parse("2026-11-23T17:00:00Z"); // Monday noon ET
    expect(listTime("2026-11-23T14:05:00Z", now)).toBe("9:05 AM");
    expect(listTime("2026-11-21T20:07:00Z", now)).toBe("Sat");
    expect(listTime("2026-11-10T20:07:00Z", now)).toBe("Nov 10");
    expect(listTime("2025-12-24T20:07:00Z", now)).toBe("Dec 24, 2025");
    expect(listTime("not a time", now)).toBe("");
  });

  it("the day boundary is New York's midnight, not UTC's", () => {
    const now = Date.parse("2026-11-23T04:30:00Z"); // 11:30 PM Sunday in New York
    expect(listTime("2026-11-23T03:00:00Z", now)).toBe("10:00 PM");
    expect(listTime("2026-11-22T14:00:00Z", now)).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });
});
