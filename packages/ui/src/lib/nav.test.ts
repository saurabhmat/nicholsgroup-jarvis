import { describe, expect, it } from "vitest";
import { activeKey, greetingFor, homeHeading, laneHref, onboardingEntry, pageHeading, MOBILE_TABS, MORE_ITEMS, NAV_ITEMS, navItem } from "./nav";

describe("navigation data", () => {
  it("has the desktop order (Get started first, Projects between Assistant and Settings) and no hidden modules", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(["Get started", "Home", "Finance", "Inbox", "Calendar", "Approvals", "Assistant", "Projects", "Settings"]);
    const text = JSON.stringify(NAV_ITEMS).toLowerCase();
    for (const hidden of ["search", "commitment", "all companies"]) expect(text).not.toContain(hidden);
  });

  it("has the signed-off iPhone tabs, and every menu entry is reachable from a tab or More", () => {
    expect(MOBILE_TABS.map((t) => t.label)).toEqual(["Home", "Approvals", "Inbox", "Ask", "More"]);
    const covered = new Set(MOBILE_TABS.flatMap((t) => t.covers));
    for (const item of NAV_ITEMS) expect(covered.has(item.key)).toBe(true);
    expect([...MORE_ITEMS].sort()).toEqual([...(MOBILE_TABS.find((t) => t.key === "more")?.covers ?? [])].sort());
  });

  it("puts Get started first with the onboarding segment, and at the top of More (no new iPhone tab)", () => {
    expect(NAV_ITEMS[0]).toMatchObject({ key: "onboarding", label: "Get started", segment: "onboarding" });
    expect(MORE_ITEMS[0]).toBe("onboarding");
    expect(MOBILE_TABS.map((t) => t.key)).not.toContain("onboarding");
    expect(activeKey("PKG", "/PKG/onboarding")).toBe("onboarding");
    expect(laneHref("PKG", navItem("onboarding").segment)).toBe("/PKG/onboarding");
    expect(navItem("onboarding").heading).toEqual({ lead: "Set up your", accent: "brain" });
  });

  it("shows the live count until every section is done, then AI brain with a check", () => {
    expect(onboardingEntry({ done: 3, total: 10 })).toEqual({ label: "Get started", badge: "3 of 10", complete: false });
    expect(onboardingEntry({ done: 0, total: 10 })).toEqual({ label: "Get started", badge: "0 of 10", complete: false });
    expect(onboardingEntry({ done: 9, total: 10 }).complete).toBe(false);
    expect(onboardingEntry({ done: 10, total: 10 })).toEqual({ label: "AI brain", complete: true });
    expect(onboardingEntry({ done: null, total: 10 })).toEqual({ label: "Get started", complete: false });
  });

  it("has no company names (rule 2)", () => {
    expect(JSON.stringify([NAV_ITEMS, MOBILE_TABS]).toLowerCase()).not.toMatch(/pub k|pkg|nichols/);
  });

  it("builds lane URLs and finds the active module", () => {
    expect(laneHref("PKG")).toBe("/PKG");
    expect(laneHref("PKG", "finance")).toBe("/PKG/finance");
    expect(activeKey("PKG", "/PKG")).toBe("home");
    expect(activeKey("PKG", "/PKG/finance/detail")).toBe("finance");
    expect(activeKey("PKG", "/PKG/more")).toBe("more");
    expect(activeKey("PKG", "/PKG/unknown")).toBeNull();
    expect(activeKey("PKG", "/PKGX/finance")).toBeNull();
    expect(activeKey("PKG", "/APK/finance")).toBeNull();
    expect(navItem("approvals").segment).toBe("approvals");
  });
});

describe("headings and the More tab", () => {
  it("derives the More tab's covers from MORE_ITEMS (single source)", () => {
    expect(MOBILE_TABS.find((t) => t.key === "more")?.covers).toBe(MORE_ITEMS);
  });

  it("has the prototype headings with accents", () => {
    expect(navItem("finance").heading).toEqual({ lead: "Finance", accent: "at a glance" });
    expect(navItem("approvals").heading).toEqual({ lead: "Approvals", accent: "waiting for you" });
    expect(navItem("inbox").heading).toEqual({ lead: "Inbox" });
  });

  const MORNING = new Date("2026-11-11T14:00:00Z"); // 9:00 AM Eastern
  it("builds the Home title with or without a name", () => {
    expect(homeHeading("Robert", MORNING)).toEqual({ lead: "Good morning,", accent: "Robert" });
    expect(homeHeading(undefined, MORNING)).toEqual({ lead: "Good morning" });
    expect(homeHeading("  ", MORNING)).toEqual({ lead: "Good morning" });
    expect(pageHeading("more")).toEqual({ lead: "More" });
    expect(pageHeading("home", "Robert", MORNING).accent).toBe("Robert");
    expect(pageHeading("home", "Robert", new Date("2026-11-11T22:00:00Z")).lead).toBe("Good evening,");
  });

  // T-240: by America/New_York time of day, whatever the viewer's zone.
  it("greets by Eastern time: morning before 12:00, afternoon 12:00-16:59, evening from 17:00", () => {
    const at = (iso: string) => greetingFor(new Date(iso));
    // November: EST (UTC-5)
    expect(at("2026-11-11T04:59:00Z")).toBe("Good evening"); // 11:59 PM the day before
    expect(at("2026-11-11T05:00:00Z")).toBe("Good morning"); // 12:00 AM
    expect(at("2026-11-11T16:59:00Z")).toBe("Good morning"); // 11:59 AM
    expect(at("2026-11-11T17:00:00Z")).toBe("Good afternoon"); // 12:00 PM
    expect(at("2026-11-11T21:59:00Z")).toBe("Good afternoon"); // 4:59 PM
    expect(at("2026-11-11T22:00:00Z")).toBe("Good evening"); // 5:00 PM
    expect(at("2026-11-12T04:59:00Z")).toBe("Good evening"); // 11:59 PM
  });
  it("follows daylight time: the same UTC instants fall an hour earlier in July (EDT, UTC-4)", () => {
    const at = (iso: string) => greetingFor(new Date(iso));
    expect(at("2026-07-01T15:59:00Z")).toBe("Good morning"); // 11:59 AM EDT
    expect(at("2026-07-01T16:00:00Z")).toBe("Good afternoon"); // 12:00 PM EDT
    expect(at("2026-07-01T20:59:00Z")).toBe("Good afternoon"); // 4:59 PM EDT
    expect(at("2026-07-01T21:00:00Z")).toBe("Good evening"); // 5:00 PM EDT
  });
  it("the DST changeover days: spring forward (Mar 8 2026) and fall back (Nov 1 2026)", () => {
    const at = (iso: string) => greetingFor(new Date(iso));
    expect(at("2026-03-08T15:59:00Z")).toBe("Good morning"); // 11:59 AM EDT (the zone switched at 2 AM)
    expect(at("2026-03-08T16:00:00Z")).toBe("Good afternoon");
    expect(at("2026-11-01T16:59:00Z")).toBe("Good morning"); // 11:59 AM EST (fell back at 2 AM)
    expect(at("2026-11-01T17:00:00Z")).toBe("Good afternoon");
  });
  it("never depends on the process zone", () => {
    const old = process.env.TZ;
    try {
      for (const tz of ["Asia/Tokyo", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = tz;
        expect(greetingFor(new Date("2026-11-11T14:00:00Z"))).toBe("Good morning");
        expect(greetingFor(new Date("2026-11-11T23:00:00Z"))).toBe("Good evening");
      }
    } finally {
      if (old === undefined) delete process.env.TZ;
      else process.env.TZ = old;
    }
  });

  it("gives every tab an icon", () => {
    expect(MOBILE_TABS.map((t) => t.icon)).toEqual(["home", "check", "mail", "chat", "more"]);
  });
});
