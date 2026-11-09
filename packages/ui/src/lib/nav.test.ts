import { describe, expect, it } from "vitest";
import { activeKey, homeHeading, laneHref, onboardingEntry, pageHeading, MOBILE_TABS, MORE_ITEMS, NAV_ITEMS, navItem } from "./nav";

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

  it("builds the Home title with or without a name", () => {
    expect(homeHeading("Robert")).toEqual({ lead: "Good morning,", accent: "Robert" });
    expect(homeHeading()).toEqual({ lead: "Good morning" });
    expect(homeHeading("  ")).toEqual({ lead: "Good morning" });
    expect(pageHeading("more")).toEqual({ lead: "More" });
    expect(pageHeading("home", "Robert").accent).toBe("Robert");
  });

  it("gives every tab an icon", () => {
    expect(MOBILE_TABS.map((t) => t.icon)).toEqual(["home", "check", "mail", "chat", "more"]);
  });
});
