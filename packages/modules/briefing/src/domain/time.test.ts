import { describe, expect, it } from "vitest";
import { otherZoneTime } from "./time";

const NY = "America/New_York";
describe("otherZoneTime", () => {
  it("shows the event's own clock when it differs from the viewer's", () => {
    expect(otherZoneTime("2026-11-12T14:00:00Z", NY, "America/Los_Angeles")).toBe("6:00 AM PST");
  });
  it("is the same zone or an unknown zone: null", () => {
    expect(otherZoneTime("2026-11-12T14:00:00Z", NY, NY)).toBeNull();
    expect(otherZoneTime("2026-11-12T14:00:00Z", NY, "Not/AZone")).toBeNull();
    expect(otherZoneTime("2026-11-12T14:00:00Z", NY, null)).toBeNull();
    expect(otherZoneTime("2026-11-12T14:00:00Z", NY, "")).toBeNull();
  });
  it("Phoenix and Los Angeles share an offset in summer (no second line) but not in winter", () => {
    expect(otherZoneTime("2026-07-15T14:00:00Z", "America/Phoenix", "America/Los_Angeles")).toBeNull();
    expect(otherZoneTime("2026-01-15T14:00:00Z", "America/Phoenix", "America/Los_Angeles")).toBe("6:00 AM PST");
  });
  it("US and EU DST change on different days: London is 4 h ahead of New York only between them", () => {
    // 2026-03-08 US spring forward, 2026-03-29 EU spring forward.
    expect(otherZoneTime("2026-03-05T14:00:00Z", NY, "Europe/London")).toBe("2:00 PM GMT");
    expect(otherZoneTime("2026-03-15T14:00:00Z", NY, "Europe/London")).toBe("2:00 PM GMT");
    expect(otherZoneTime("2026-03-31T14:00:00Z", NY, "Europe/London")).toBe("3:00 PM GMT+1");
  });
  it("handles a half-hour zone (India)", () => {
    expect(otherZoneTime("2026-07-15T14:00:00Z", NY, "Asia/Kolkata")).toMatch(/^7:30 PM /);
  });
});
