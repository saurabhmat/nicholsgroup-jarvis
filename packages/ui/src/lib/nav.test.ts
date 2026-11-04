import { describe, expect, it } from "vitest";
import { activeKey, laneHref, MOBILE_TABS, MORE_ITEMS, NAV_ITEMS, navItem } from "./nav";

describe("navigation data", () => {
  it("has the desktop order (Projects between Assistant and Settings) and no hidden modules", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(["Home", "Finance", "Inbox", "Calendar", "Approvals", "Assistant", "Projects", "Settings"]);
    const text = JSON.stringify(NAV_ITEMS).toLowerCase();
    for (const hidden of ["search", "commitment", "all companies"]) expect(text).not.toContain(hidden);
  });

  it("has the signed-off iPhone tabs, and every menu entry is reachable from a tab or More", () => {
    expect(MOBILE_TABS.map((t) => t.label)).toEqual(["Home", "Approvals", "Inbox", "Ask", "More"]);
    const covered = new Set(MOBILE_TABS.flatMap((t) => t.covers));
    for (const item of NAV_ITEMS) expect(covered.has(item.key)).toBe(true);
    expect([...MORE_ITEMS].sort()).toEqual([...(MOBILE_TABS.find((t) => t.key === "more")?.covers ?? [])].sort());
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
