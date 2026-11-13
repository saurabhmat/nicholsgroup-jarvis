// @vitest-environment jsdom
// T-234 part 1: the KPI strip (not-connected tiles at equal height), the header status dot, "Next 7 days" collapsed by
// default, the news empty state and the projects card.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CoverageDot } from "./coverage-dot";
import { CollapsibleSection } from "./collapsible-section";
import { GovConNews } from "./home-news";
import { ProjectsGlance } from "./home-projects";
import type { CoverageItem } from "@nichols/briefing/domain";

afterEach(cleanup);

const item = (state: CoverageItem["state"]): CoverageItem => ({ stream: "mail", account: "a@pubk.test", connectionId: "c", provider: "google", status: "active", configured: true, lastSyncAt: null, errorKind: null, state, reason: null });

describe("Sync status line (T-238 part D)", () => {
  const NOW = new Date("2026-11-12T15:00:00Z"); // 10:00 AM ET
  const at = (stream: "mail" | "calendar", min: number, over: Partial<CoverageItem> = {}): CoverageItem => ({ ...item("ok"), stream, lastSyncAt: new Date(NOW.getTime() - min * 60_000).toISOString(), ...over });
  it("says when mail and calendar last synced (the oldest per stream), links to Connections, with Eastern times in the name and title", () => {
    render(<CoverageDot laneId="PKG" view={{ items: [at("mail", 4), at("mail", 7), at("calendar", 12), item("not_connected")], unavailable: false }} now={NOW} />);
    const dot = screen.getByTestId("coverage-dot");
    expect(dot.querySelector("[data-slot=sync-full]")?.textContent).toBe("Mail synced 7 min ago \u00b7 Calendar synced 12 min ago");
    expect(dot.textContent).toContain("Synced"); // the compact phone word
    expect(dot.getAttribute("data-status")).toBe("synced");
    expect(dot.getAttribute("href")).toBe("/PKG/settings#connections");
    expect(dot.getAttribute("aria-label")).toBe("Mail last synced 9:53 AM ET. Calendar last synced 9:48 AM ET. Open Settings, Connections.");
    expect(dot.getAttribute("title")).toBe(dot.getAttribute("aria-label"));
    expect(dot.textContent).not.toContain("Sync issue");
  });
  it("a failed stream shows its real error as fixed text, and the compact word is 'Sync issue' (not colour only)", () => {
    render(<CoverageDot laneId="PKG" view={{ items: [at("mail", 3, { errorKind: "reconnect_required", state: "error", status: "reconnect_required" }), at("calendar", 5)], unavailable: false }} now={NOW} />);
    const dot = screen.getByTestId("coverage-dot");
    expect(dot.getAttribute("data-status")).toBe("failed");
    expect(dot.querySelector("[data-slot=sync-full]")?.textContent).toBe("Mail sync failed: Google access expired. Reconnect in Settings. \u00b7 Calendar synced 5 min ago");
    expect(dot.textContent).toContain("Sync issue");
    expect(dot.getAttribute("aria-label")).toContain("Mail sync failed: Google access expired. Reconnect in Settings.");
    expect(dot.getAttribute("href")).toBe("/PKG/settings#connections");
  });
  it("with several mailboxes it says how many failed; provider text never appears", () => {
    render(<CoverageDot laneId="PKG" view={{ items: [at("mail", 3), at("mail", 3, { errorKind: "Bearer secret" })], unavailable: false }} now={NOW} />);
    const text = screen.getByTestId("coverage-dot").querySelector("[data-slot=sync-full]")?.textContent;
    expect(text).toBe("Mail sync failed for 1 of 2 mailboxes: The last sync did not finish. Try Sync now; if it continues, check Settings.");
    expect(text).not.toMatch(/secret/);
  });
  it("a source that never synced says so", () => {
    render(<CoverageDot laneId="PKG" view={{ items: [at("mail", 0, { lastSyncAt: null, state: "stale" })], unavailable: false }} now={NOW} />);
    expect(screen.getByTestId("coverage-dot").querySelector("[data-slot=sync-full]")?.textContent).toBe("Mail not synced yet");
    expect(screen.getByTestId("coverage-dot").getAttribute("data-status")).toBe("attention");
  });
  it("shows Sync now beside it only when the caller may sync", () => {
    const view = { items: [at("mail", 4)], unavailable: false };
    render(<CoverageDot laneId="PKG" view={view} now={NOW} />);
    expect(screen.queryByTestId("home-sync-now")).toBeNull();
    cleanup();
    render(<CoverageDot laneId="PKG" view={view} now={NOW} canSync />);
    expect(screen.getByTestId("home-sync-now").tagName).toBe("BUTTON");
  });
  it.each([
    ["only a source that was never connected", [item("not_connected")]],
    ["no sources", []],
  ])("is hidden when %s", (_n, items) => {
    render(<CoverageDot laneId="PKG" view={{ items, unavailable: false }} canSync />);
    expect(screen.queryByTestId("coverage-dot")).toBeNull();
    expect(screen.queryByTestId("home-sync-now")).toBeNull();
  });
  it("when Coverage could not be read it says 'Status unknown' (accessible label, links to Settings), never a silent all-clear", () => {
    render(<CoverageDot laneId="PKG" view={{ items: [], unavailable: true }} />);
    const dot = screen.getByTestId("coverage-dot");
    expect(dot.getAttribute("data-status")).toBe("unknown");
    expect(dot.textContent).toContain("Status unknown");
    expect(dot.getAttribute("aria-label")).toMatch(/could not be checked/);
    expect(dot.getAttribute("href")).toBe("/PKG/settings#connections");
  });
});

describe("Next 7 days (collapsible)", () => {
  it("is collapsed by default and expands and collapses on click", () => {
    render(<CollapsibleSection title="Next 7 days" testId="next-7-days"><p>Client call</p></CollapsibleSection>);
    const button = screen.getByRole("button", { name: /Next 7 days/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Client call").closest("[hidden]")).toBeTruthy(); // hidden: out of the accessibility tree and tab order
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Client call").closest("[hidden]")).toBeNull();
    expect(screen.getByTestId("next-7-days").getAttribute("data-open")).toBe("true");
    expect(screen.getByRole("region", { name: "Next 7 days" })).toBe(screen.getByTestId("next-7-days")); // labelled by its title, not the button text
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Client call").closest("[hidden]")).toBeTruthy();
  });
});

describe("News and Projects slots", () => {
  it("GovCon news is a slim line 'GovCon news is off' until it is configured", () => {
    render(<GovConNews />);
    expect(screen.getByRole("region", { name: "GovCon news" })).toBeTruthy();
    expect(screen.getByTestId("news-empty").textContent).toBe("GovCon news is off");
  });
  it("Projects at a glance is a slim line; 'Connect in Settings' only for admins", () => {
    const { rerender } = render(<ProjectsGlance laneId="PKG" />);
    expect(screen.getByRole("region", { name: "Projects at a glance" })).toBeTruthy();
    expect(screen.getByTestId("projects-notice").textContent).toBe("No project board connected");
    expect(screen.queryByRole("link")).toBeNull();
    rerender(<ProjectsGlance laneId="PKG" canConnect />);
    expect(screen.getByTestId("projects-notice").textContent).toBe("No project board connected\u00b7Connect in Settings");
    expect(screen.getByRole("link", { name: "Connect in Settings" }).getAttribute("href")).toBe("/PKG/settings#connections");
  });
});

describe("KPI loading skeleton", () => {
  it("is one slim bar (h-10), not five tall tiles", async () => {
    const { KpiStripSkeleton } = await import("./page-skeleton");
    render(<KpiStripSkeleton />);
    const bar = screen.getByTestId("kpi-skeleton");
    expect(bar.className).toMatch(/\bh-10\b/);
    expect(bar.children).toHaveLength(0);
  });
});
