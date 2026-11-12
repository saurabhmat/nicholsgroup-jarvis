// @vitest-environment jsdom
// T-234 part 1: the KPI strip (not-connected tiles at equal height), the header status dot, "Next 7 days" collapsed by
// default, the news empty state and the projects card.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { toHomeFinance } from "@/lib/home-finance";
import { kpiTiles } from "@/lib/home-kpi-tiles";
import { KpiStrip, TILE_HEIGHT } from "./kpi-strip";
import { CoverageDot } from "./coverage-dot";
import { CollapsibleSection } from "./collapsible-section";
import { GovConNews } from "./home-news";
import { ProjectsGlance } from "./home-projects";
import type { CoverageItem } from "@nichols/briefing/domain";

afterEach(cleanup);

const okRow = {
  state: "ok", as_of: "2026-11-11T20:00:00Z", last_sync_at: "2026-11-11T19:55:00Z", connection_status: "active",
  cash_reason: null, cash_total: 1314.66, cash_as_of: "2026-11-10T20:00:00Z", cash_accounts: [], cash_unmapped: 0,
  ar_reason: null, ar_over_30: 160.25, ar_invoices: 3, ar_unmapped: 0,
  pnl_reason: null, pnl_income: 500, pnl_expenses: 200, pnl_net: 300, pnl_start: "2026-11-01", pnl_end: "2026-11-11", pnl_method: "accrual", pnl_partial: false, pnl_as_of: "2026-11-11T20:00:00Z",
};
const tilesOf = () => screen.getAllByTestId("kpi-tile");

const ALL_FEEDS = [{ provider: "quickbooks", status: "active" }, { provider: "stripe", status: "active" }, { provider: "ghl", status: "active" }];
const BANNER = "Connect QuickBooks, Stripe and GoHighLevel to see cash, AR, P&L, MRR and subscribers";

describe("KPI strip (T-235 part 4: only what is connected)", () => {
  it("everything connected: five tiles fill one row from lg, in the brief's order; Cash carries Book balance; no banner", () => {
    render(<KpiStrip laneId="PKG" canConnect tiles={kpiTiles(toHomeFinance([okRow]), ALL_FEEDS)} />);
    const strip = screen.getByTestId("home-kpis");
    expect(strip.className).toMatch(/lg:grid-cols-5/);
    expect(strip.className).toMatch(/(^| )grid-cols-1( |$)/); // one column on a phone
    expect(strip.className).not.toMatch(/(^| )grid-cols-2( |$)/);
    expect(tilesOf().map((t) => t.getAttribute("data-kpi"))).toEqual(["cash", "ar30", "pnl", "mrr", "subscribers"]);
    const [cash, ar, pnl, mrr] = tilesOf() as HTMLElement[];
    expect(within(cash as HTMLElement).getByText("Book balance")).toBeTruthy();
    expect(within(cash as HTMLElement).getByText("$1,314.66")).toBeTruthy();
    expect(within(ar as HTMLElement).getByText("$160.25")).toBeTruthy();
    expect(within(pnl as HTMLElement).getByText("$300.00")).toBeTruthy();
    // connected but no figure yet: the dash is visible only; screen readers get "No figure" (an aria-label on a <p> is an axe violation)
    expect(mrr?.querySelector("[data-slot=kpi-value] [aria-hidden]")?.textContent).toBe("—");
    expect(mrr?.querySelector("[data-slot=kpi-value] .sr-only")?.textContent).toBe("No figure");
    expect(mrr?.querySelector("[data-slot=kpi-value]")?.hasAttribute("aria-label")).toBe(false);
    expect(screen.queryByTestId("home-kpis-banner")).toBeNull();
    expect(screen.queryByText("Not connected")).toBeNull();
  });

  it("QuickBooks only: three tiles that fill the row equally; no empty MRR or subscriber tile", () => {
    render(<KpiStrip laneId="PKG" canConnect tiles={kpiTiles(toHomeFinance([okRow]), [{ provider: "quickbooks", status: "active" }])} />);
    expect(tilesOf().map((t) => t.getAttribute("data-kpi"))).toEqual(["cash", "ar30", "pnl"]);
    expect(screen.getByTestId("home-kpis").className).toMatch(/lg:grid-cols-3/);
    expect(screen.queryByTestId("home-kpis-banner")).toBeNull();
  });

  it("nothing connected: one slim banner with the exact text and a Settings link, no tiles", () => {
    render(<KpiStrip laneId="PKG" canConnect tiles={kpiTiles(toHomeFinance([{ state: "not_connected" }]), [{ provider: "quickbooks", status: "active" }])} />);
    expect(screen.queryAllByTestId("kpi-tile")).toHaveLength(0);
    const banner = screen.getByTestId("home-kpis-banner");
    expect(banner.textContent).toContain(BANNER);
    expect(within(banner).getByRole("link", { name: /Settings/ }).getAttribute("href")).toBe("/PKG/settings#connections");
    expect(banner.className).not.toMatch(/min-h|h-\d/); // slim: no fixed tile height
    expect(document.body.textContent).not.toMatch(/\$/);
  });

  it("nothing connected and a caller who cannot see feeds: the same banner (never 'Not available yet' tiles)", () => {
    render(<KpiStrip laneId="PKG" canConnect tiles={kpiTiles(toHomeFinance([{ state: "not_connected" }]), [])} />);
    expect(screen.getByTestId("home-kpis-banner")).toBeTruthy();
    expect(screen.queryAllByTestId("kpi-tile")).toHaveLength(0);
  });

  it("a role that cannot connect (no canConnect) sees no banner and no tiles when nothing is connected", () => {
    const { container } = render(<KpiStrip laneId="PKG" tiles={kpiTiles(toHomeFinance([{ state: "not_connected" }]), [])} />);
    expect(container.textContent).toBe("");
  });

  it("a role without the finance view gets no finance tile or figure, no revenue tile (MRR, subscribers) even with connected feeds, and no banner", () => {
    const { container } = render(<KpiStrip laneId="PKG" tiles={kpiTiles({ state: "no_access" }, [])} />);
    expect(container.textContent).toBe("");
    cleanup();
    expect(kpiTiles({ state: "no_access" }, ALL_FEEDS)).toEqual([]);
    render(<KpiStrip laneId="PKG" tiles={kpiTiles({ state: "no_access" }, ALL_FEEDS)} />);
    expect(document.body.textContent).not.toMatch(/MRR|Paid subscribers|Cash|Book balance|AR > 30|P&L|\$/);
  });

  it("a QuickBooks outage still shows its three tiles as plain notes (the connection is unknown, not absent)", () => {
    render(<KpiStrip laneId="PKG" tiles={kpiTiles({ state: "unavailable" }, [{ provider: "stripe", status: "active" }, { provider: "ghl", status: "active" }])} />);
    expect(screen.getAllByText("Could not load. Reload in a minute.")).toHaveLength(3);
    const [, , , mrr] = tilesOf() as HTMLElement[];
    expect(mrr?.getAttribute("data-status")).toBe("no_data"); // connected feed, no read yet: waiting
    expect(mrr?.textContent).toContain("Waiting for the Stripe sync");
  });

  it("tiles have the same height classes whether or not they carry a figure (equal heights)", () => {
    render(<KpiStrip laneId="PKG" tiles={kpiTiles(toHomeFinance([okRow]), ALL_FEEDS)} />);
    const classes = tilesOf().map((t) => t.className);
    for (const c of classes) {
      expect(c).toContain(TILE_HEIGHT);
      expect(c).toContain("h-full");
    }
    expect(new Set(classes).size).toBe(1);
    expect(screen.getByTestId("home-kpis").className).toMatch(/items-stretch/);
    for (const t of tilesOf()) expect([...t.children].map((c) => c.tagName)).toHaveLength(3);
  });

  it("figures carry their caveats (rule 7): unmapped accounts and invoices, payroll, and the P&L month", () => {
    render(<KpiStrip laneId="PKG" tiles={kpiTiles(toHomeFinance([{ ...okRow, cash_unmapped: 2, ar_unmapped: 1, pnl_partial: true }]), [])} />);
    const [cash, ar, pnl] = tilesOf() as HTMLElement[];
    expect(within(cash as HTMLElement).getByText("Excludes 2 unmapped accounts")).toBeTruthy();
    expect(within(ar as HTMLElement).getByText("Excludes 1 invoice with no company")).toBeTruthy();
    expect(within(pnl as HTMLElement).getByText("Excludes payroll accounts")).toBeTruthy();
    expect(within(pnl as HTMLElement).getByText("Net, November 2026")).toBeTruthy();
  });

  it("a QuickBooks connection that needs reconnecting is said on the figures", () => {
    render(<KpiStrip laneId="PKG" tiles={kpiTiles(toHomeFinance([{ ...okRow, connection_status: "reconnect_required" }]), [])} />);
    expect(screen.getAllByText("May be out of date. Reconnect QuickBooks in Settings.").length).toBe(3);
  });
});

const item = (state: CoverageItem["state"]): CoverageItem => ({ stream: "mail", account: "a@pubk.test", connectionId: "c", provider: "google", status: "active", configured: true, lastSyncAt: null, errorKind: null, state, reason: null });

describe("Coverage status dot", () => {
  it("shows for a stale or errored source, links to Settings -> Connections and has an accessible name (not colour only)", () => {
    render(<CoverageDot laneId="PKG" view={{ items: [item("ok"), item("stale"), item("error")], unavailable: false }} />);
    const dot = screen.getByTestId("coverage-dot");
    expect(dot.getAttribute("href")).toBe("/PKG/settings#connections");
    expect(dot.getAttribute("aria-label")).toBe("2 sources are stale or in error. Open Settings, Connections.");
    expect(dot.textContent).toContain("Sync issue"); // a visible word too
  });
  it.each([
    ["all sources ok", [item("ok")]],
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
  it("GovCon news shows 'News not configured' until part 4 supplies items", () => {
    render(<GovConNews />);
    expect(screen.getByRole("region", { name: "GovCon news" })).toBeTruthy();
    expect(screen.getByTestId("news-empty").textContent).toBe("News not configured");
  });
  it("Projects at a glance is compact and says no board is connected", () => {
    render(<ProjectsGlance />);
    expect(screen.getByRole("region", { name: "Projects at a glance" })).toBeTruthy();
    expect(screen.getByTestId("projects-notice").textContent).toMatch(/No project board connected/);
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
