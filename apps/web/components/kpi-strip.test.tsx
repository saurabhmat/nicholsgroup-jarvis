// @vitest-environment jsdom
// T-237 part B: the KPI row. Synthetic figures only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { toHomeFinance } from "@/lib/home-finance";
import { toHomeFinanceDetail } from "@/lib/home-finance-detail";
import { kpiTiles, quickbooksStrip } from "@/lib/home-kpi-tiles";
import { KpiStrip, TILE_HEIGHT } from "./kpi-strip";

afterEach(cleanup);

const okRow = {
  state: "ok", as_of: "2026-11-11T20:00:00Z", last_sync_at: "2026-11-11T19:55:00Z", connection_status: "active",
  cash_reason: null, cash_total: 1314.66, cash_as_of: "2026-11-10T20:00:00Z", cash_accounts: [{ name: "Operating", book_balance: 1000, shared: false }, { name: "Reserve", book_balance: 314.66, shared: false }], cash_unmapped: 0,
  ar_reason: null, ar_over_30: 160.25, ar_invoices: 3, ar_unmapped: 0,
  pnl_reason: null, pnl_income: 500, pnl_expenses: 200, pnl_net: 300, pnl_start: "2026-11-01", pnl_end: "2026-11-11", pnl_method: "accrual", pnl_partial: false, pnl_as_of: "2026-11-11T20:00:00Z",
};
const detailRow = { state: "ok", as_of: "2026-11-11T20:00:00Z", bills_due_14_total: 410.5, bills_due_14_count: 2, aging: [], oldest: [], unmapped_invoices: 0, unmapped_bills: 0 };
const fin = toHomeFinance([okRow]);
const det = toHomeFinanceDetail([detailRow]);
const none = toHomeFinanceDetail([]);
const STRIPE = [{ provider: "quickbooks", status: "active" }, { provider: "stripe", status: "active" }, { provider: "ghl", status: "active" }];
const tilesOf = () => screen.getAllByTestId("kpi-tile");

describe("KPI row", () => {
  it("connected: five tiles in the brief's order, an auto-fit grid, no Paid subscribers tile, no comparison text", () => {
    render(<KpiStrip laneId="PKG" tiles={kpiTiles(fin, det, STRIPE)} />);
    const strip = screen.getByTestId("home-kpis");
    expect(strip.className).toContain("md:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]");
    expect(strip.className).toMatch(/(^| )grid-cols-2( |$)/); // two per row on a phone
    expect(tilesOf().map((t) => t.getAttribute("data-kpi"))).toEqual(["cash", "ar30", "bills14", "pnl", "mrr"]);
    const [cash, ar, bills, pnl, mrr] = tilesOf() as HTMLElement[];
    expect(within(cash as HTMLElement).getByText("Book balance")).toBeTruthy();
    expect(within(cash as HTMLElement).getByText("$1,314.66")).toBeTruthy();
    expect(within(cash as HTMLElement).getByText("2 accounts · QuickBooks")).toBeTruthy();
    expect(within(ar as HTMLElement).getByText("$160.25")).toBeTruthy();
    expect(within(ar as HTMLElement).getByText("3 invoices · QuickBooks")).toBeTruthy();
    expect(within(bills as HTMLElement).getByText("$410.50")).toBeTruthy();
    expect(within(bills as HTMLElement).getByText("2 bills · QuickBooks")).toBeTruthy();
    expect(within(pnl as HTMLElement).getByText("$300.00")).toBeTruthy();
    expect(within(pnl as HTMLElement).getByText("QuickBooks")).toBeTruthy();
    // MRR: connected, but there is no Stripe read: the waiting note and a dash, never a number
    expect(mrr?.querySelector("[data-slot=kpi-value] [aria-hidden]")?.textContent).toBe("—");
    expect(mrr?.textContent).toContain("Waiting for the Stripe sync");
    expect(screen.queryByText(/Paid subscribers/i)).toBeNull();
    expect(screen.getByTestId("home-kpis").textContent).not.toMatch(/vs |%/);
  });

  it("figure colours: AR over 30 days uses the danger token, positive net income the success token; zero AR and negative net stay neutral", () => {
    render(<KpiStrip laneId="PKG" tiles={kpiTiles(fin, det, [])} />);
    const val = (k: string) => screen.getByTestId("home-kpis").querySelector(`[data-kpi=${k}] [data-slot=kpi-value]`) as HTMLElement;
    expect(val("ar30").className).toContain("text-danger");
    expect(val("pnl").className).toContain("text-success");
    expect(val("cash").className).toContain("text-foreground");
    cleanup();
    render(<KpiStrip laneId="PKG" tiles={kpiTiles(toHomeFinance([{ ...okRow, ar_over_30: 0, ar_invoices: 0, pnl_net: -5 }]), det, [])} />);
    expect(val("ar30").className).not.toContain("text-danger");
    expect(val("pnl").className).not.toContain("text-success");
  });

  it("without a Stripe feed there is no MRR tile", () => {
    render(<KpiStrip laneId="PKG" tiles={kpiTiles(fin, det, [{ provider: "quickbooks", status: "active" }])} />);
    expect(tilesOf().map((t) => t.getAttribute("data-kpi"))).toEqual(["cash", "ar30", "bills14", "pnl"]);
  });

  const notConnected = toHomeFinance([{ state: "not_connected" }]);
  const renderStrip = (finance: Parameters<typeof quickbooksStrip>[0], canConnect: boolean, feeds: Parameters<typeof kpiTiles>[2] = []) =>
    render(<KpiStrip laneId="PKG" tiles={kpiTiles(finance, none, feeds)} strip={quickbooksStrip(finance, canConnect)} />);

  it("T-240: QuickBooks not connected: no tiles and ONE slim strip line with the Connect action (owner / admin_technical) to Settings -> Connections", () => {
    renderStrip(notConnected, true);
    expect(screen.queryAllByTestId("kpi-tile")).toHaveLength(0);
    expect(screen.queryByTestId("home-kpis")).toBeNull();
    const strip = screen.getByTestId("qb-strip");
    expect(strip.textContent).toContain("QuickBooks is not connected. Connect it to see cash, AR and bills.");
    expect(strip.getAttribute("role")).toBe("status");
    expect(strip.getAttribute("data-kind")).toBe("not_connected");
    const link = within(strip).getByTestId("kpi-connect");
    expect(link.getAttribute("href")).toBe("/PKG/settings#connections");
    expect(link.getAttribute("aria-label")).toBe("Connect QuickBooks in Settings");
    expect(link.textContent).toContain("Connect");
    // slim: one line of text, not a tile (no tile height, no card shadow)
    expect(strip.className).not.toContain(TILE_HEIGHT);
    expect(strip.className).not.toContain("shadow-card");
    expect(strip.className).toContain("py-2");
  });

  it("T-240: not connected and the role cannot connect: no strip, no tile, nothing at all", () => {
    expect(quickbooksStrip(notConnected, false)).toBeNull();
    expect(kpiTiles(notConnected, none, [])).toEqual([]);
    const { container } = renderStrip(notConnected, false);
    expect(container.firstChild).toBeNull();
  });

  it("T-240: connected but reconnect_required: the strip says so instead, the action only for a role that can connect; the figures stay with their stale note", () => {
    const stale = toHomeFinance([{ ...okRow, connection_status: "reconnect_required" }]);
    const { unmount } = renderStrip(stale, true);
    const strip = screen.getByTestId("qb-strip");
    expect(strip.getAttribute("data-kind")).toBe("reconnect_required");
    expect(strip.textContent).toContain("QuickBooks needs to be reconnected. Its figures may be out of date.");
    expect(strip.textContent).not.toContain("not connected");
    expect(within(strip).getByTestId("kpi-connect").getAttribute("aria-label")).toBe("Reconnect QuickBooks in Settings");
    expect(tilesOf()).toHaveLength(4);
    unmount();
    renderStrip(stale, false);
    expect(screen.getByTestId("qb-strip").textContent).toContain("needs to be reconnected");
    expect(screen.queryByTestId("kpi-connect")).toBeNull(); // no action for other roles
  });

  it("T-240: no strip when QuickBooks is fine, in an outage or for a role without the finance view; the row shows only connected sources", () => {
    expect(quickbooksStrip(fin, true)).toBeNull();
    expect(quickbooksStrip({ state: "unavailable" }, true)).toBeNull();
    expect(quickbooksStrip({ state: "no_access" }, true)).toBeNull();
    // Stripe connected, QuickBooks not: the MRR tile only, plus the strip
    renderStrip(notConnected, true, STRIPE);
    expect(tilesOf().map((t) => t.getAttribute("data-kpi"))).toEqual(["mrr"]);
    expect(screen.getByTestId("qb-strip")).toBeTruthy();
  });

  it("a role without the finance view sees no finance tile, not even a Stripe one", () => {
    expect(kpiTiles({ state: "no_access" }, { state: "no_access" }, STRIPE)).toEqual([]);
  });

  it("a QuickBooks outage still shows its four tiles as plain notes", () => {
    render(<KpiStrip laneId="PKG" tiles={kpiTiles({ state: "unavailable" }, { state: "unavailable" }, [])} />);
    expect(screen.getAllByText("Could not load. Reload in a minute.")).toHaveLength(4);
  });

  it("an unreadable detail leaves only the bills tile without a figure", () => {
    render(<KpiStrip laneId="PKG" tiles={kpiTiles(fin, { state: "unavailable" }, [])} />);
    const bills = tilesOf()[2] as HTMLElement;
    expect(bills.getAttribute("data-status")).toBe("no_data");
    expect(within(tilesOf()[0] as HTMLElement).getByText("$1,314.66")).toBeTruthy();
  });

  it("tiles share the same height classes and three rows", () => {
    render(<KpiStrip laneId="PKG" tiles={kpiTiles(fin, det, STRIPE)} />);
    const classes = tilesOf().map((t) => t.className);
    for (const c of classes) {
      expect(c).toContain(TILE_HEIGHT);
      expect(c).toContain("h-full");
    }
    expect(new Set(classes).size).toBe(1);
    for (const t of tilesOf()) expect([...t.children].map((c) => c.tagName)).toHaveLength(3);
  });

  it("figures carry their caveats (rule 7) and a stale connection is said on every figure", () => {
    render(<KpiStrip laneId="PKG" tiles={kpiTiles(toHomeFinance([{ ...okRow, cash_unmapped: 2, ar_unmapped: 1, pnl_partial: true, connection_status: "reconnect_required" }]), toHomeFinanceDetail([{ ...detailRow, unmapped_bills: 1 }]), [])} />);
    const [cash, ar, bills, pnl] = tilesOf() as HTMLElement[];
    expect(within(cash as HTMLElement).getByText("Excludes 2 unmapped accounts")).toBeTruthy();
    expect(within(ar as HTMLElement).getByText("Excludes 1 invoice with no company")).toBeTruthy();
    expect(within(bills as HTMLElement).getByText("Excludes 1 bill with no company")).toBeTruthy();
    expect(within(pnl as HTMLElement).getByText("Excludes payroll accounts")).toBeTruthy();
    expect(screen.getAllByText("May be out of date. Reconnect QuickBooks in Settings.")).toHaveLength(4);
  });
});
