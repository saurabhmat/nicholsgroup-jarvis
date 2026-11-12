// @vitest-environment jsdom
// T-234 part 1: the KPI strip (not-connected tiles at equal height), the header status dot, "Next 7 days" collapsed by
// default, the news empty state and the projects card.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CoverageDot, syncedLabel } from "./coverage-dot";
import { CollapsibleSection } from "./collapsible-section";
import { GovConNews } from "./home-news";
import { ProjectsGlance } from "./home-projects";
import type { CoverageItem } from "@nichols/briefing/domain";

afterEach(cleanup);

const item = (state: CoverageItem["state"]): CoverageItem => ({ stream: "mail", account: "a@pubk.test", connectionId: "c", provider: "google", status: "active", configured: true, lastSyncAt: null, errorKind: null, state, reason: null });

describe("Coverage status dot", () => {
  it("shows for a stale or errored source, links to Settings -> Connections and has an accessible name (not colour only)", () => {
    render(<CoverageDot laneId="PKG" view={{ items: [item("ok"), item("stale"), item("error")], unavailable: false }} />);
    const dot = screen.getByTestId("coverage-dot");
    expect(dot.getAttribute("href")).toBe("/PKG/settings#connections");
    expect(dot.getAttribute("aria-label")).toBe("2 sources are stale or in error. Open Settings, Connections.");
    expect(dot.textContent).toContain("Sync issue"); // a visible word too
  });
  it("all sources fine: a green dot and 'All sources synced · N min ago' (the oldest last sync), linking to Connections", () => {
    const at = (min: number) => ({ ...item("ok"), lastSyncAt: new Date(Date.parse("2026-11-12T15:00:00Z") - min * 60_000).toISOString() });
    render(<CoverageDot laneId="PKG" view={{ items: [at(2), at(7), item("not_connected")], unavailable: false }} now={new Date("2026-11-12T15:00:00Z")} />);
    const dot = screen.getByTestId("coverage-dot");
    expect(dot.textContent).toBe("All sources synced \u00b7 7 min ago");
    expect(dot.getAttribute("data-status")).toBe("synced");
    expect(dot.getAttribute("href")).toBe("/PKG/settings#connections");
  });
  it("all sources fine but no sync time known: just 'All sources synced'", () => {
    render(<CoverageDot laneId="PKG" view={{ items: [item("ok")], unavailable: false }} />);
    expect(screen.getByTestId("coverage-dot").textContent).toBe("All sources synced");
  });
  it("syncedLabel uses only the sources that are ok: a stale source's older sync does not count, and an unparseable time is ignored", () => {
    const now = new Date("2026-11-12T15:00:00Z");
    const at = (state: CoverageItem["state"], iso: string | null) => ({ ...item(state), lastSyncAt: iso });
    expect(syncedLabel([at("ok", "2026-11-12T14:58:00Z"), at("stale", "2026-11-10T00:00:00Z"), at("ok", "2026-11-12T14:55:00Z")], now)).toBe("All sources synced \u00b7 5 min ago");
    expect(syncedLabel([at("ok", "not a date")], now)).toBe("All sources synced");
    expect(syncedLabel([at("ok", "not a date"), at("ok", "2026-11-12T14:58:00Z")], now)).toBe("All sources synced \u00b7 2 min ago");
  });
  it("a mix of ok and stale sources is a sync issue, never the all-synced label", () => {
    render(<CoverageDot laneId="PKG" view={{ items: [{ ...item("ok"), lastSyncAt: "2026-11-12T14:58:00Z" }, item("stale")], unavailable: false }} now={new Date("2026-11-12T15:00:00Z")} />);
    expect(screen.getByTestId("coverage-dot").textContent).toBe("Sync issue");
    expect(screen.getByTestId("coverage-dot").getAttribute("aria-label")).toBe("1 source is stale or in error. Open Settings, Connections.");
  });
  it.each([
    ["only a source that was never connected", [item("not_connected")]],
    ["no sources", []],
  ])("is hidden when %s", (_n, items) => {
    render(<CoverageDot laneId="PKG" view={{ items, unavailable: false }} />);
    expect(screen.queryByTestId("coverage-dot")).toBeNull();
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
