// The Windows-to-IANA zone table of the Microsoft calendar sync (T-067): our own assumption (Microsoft documents no mapping), so these tests pin what it covers, that
// no entry is dead (Node's Intl must know every IANA name), and that anything outside the table is refused, never guessed.
import { describe, expect, it } from "vitest";
import { ianaForWindowsZone, WINDOWS_ZONE_PAIRS } from "./cal-zones";

describe("the table has no dead entries and no duplicates", () => {
  it("every IANA name is one Intl knows", () => {
    for (const [windows, iana] of WINDOWS_ZONE_PAIRS) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: iana }), `${windows} -> ${iana}`).not.toThrow();
    }
  });
  it("every Windows name appears once (case-insensitively)", () => {
    const names = WINDOWS_ZONE_PAIRS.map(([w]) => w.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("coverage (the common zones the sync promises)", () => {
  const expectations: Record<string, string> = {
    "Eastern Standard Time": "America/New_York",
    "Central Standard Time": "America/Chicago",
    "Mountain Standard Time": "America/Denver",
    "Pacific Standard Time": "America/Los_Angeles",
    "Alaskan Standard Time": "America/Anchorage",
    "Hawaiian Standard Time": "Pacific/Honolulu",
    "US Mountain Standard Time": "America/Phoenix", // Arizona
    UTC: "UTC",
    "GMT Standard Time": "Europe/London",
    "W. Europe Standard Time": "Europe/Berlin",
    "Romance Standard Time": "Europe/Paris",
    "Central European Standard Time": "Europe/Warsaw",
    "India Standard Time": "Asia/Kolkata",
    "China Standard Time": "Asia/Shanghai",
    "Tokyo Standard Time": "Asia/Tokyo",
    "Korea Standard Time": "Asia/Seoul",
    "Singapore Standard Time": "Asia/Singapore",
    "AUS Eastern Standard Time": "Australia/Sydney",
    "W. Australia Standard Time": "Australia/Perth",
    "New Zealand Standard Time": "Pacific/Auckland",
  };
  it.each(Object.entries(expectations))("%s -> %s", (windows, iana) => {
    expect(ianaForWindowsZone(windows)).toBe(iana);
  });
  it("is case-insensitive on the Windows name", () => {
    expect(ianaForWindowsZone("pacific standard time")).toBe("America/Los_Angeles");
  });
});

describe("never guessed", () => {
  it("a zone that is not in the table, the custom marker, an invalid IANA-looking name, odd characters, an empty or non-string value, and a very long one are all null", () => {
    for (const v of ["Synthetic Standard Time", "tzone://Microsoft/Custom", "Mars/Olympus", "Europe/Lon don", "Europe/London;x", "Pacific\u0000", "", undefined, null, 42, "x".repeat(101), "Pacific Standard Time "]) {
      expect(ianaForWindowsZone(v), String(v)).toBeNull();
    }
  });
});

describe("an IANA name that Intl knows is accepted as a fallback (Microsoft says such names can appear; the table does not cover every region)", () => {
  it("Europe/London, America/Santiago and America/New_York map to themselves", () => {
    for (const z of ["Europe/London", "America/Santiago", "America/New_York"]) expect(ianaForWindowsZone(z)).toBe(z);
  });
  it("the Windows table still wins for a Windows name", () => {
    expect(ianaForWindowsZone("Eastern Standard Time")).toBe("America/New_York");
  });
});
