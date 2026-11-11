// @vitest-environment jsdom
// T-233: the Home finance cards. Figures are pre-formatted by lib/home-finance; here only what is drawn.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { toHomeFinance } from "@/lib/home-finance";
import { FinanceCards } from "./home-finance";

afterEach(cleanup);

const row = {
  state: "ok",
  as_of: "2026-11-11T20:00:00Z",
  last_sync_at: "2026-11-11T19:55:00Z",
  connection_status: "active",
  cash_reason: null,
  cash_total: 1314.66,
  cash_as_of: "2026-11-10T20:00:00Z",
  cash_accounts: [
    { name: "Operating", book_balance: 1234.56, shared: false },
    { name: "Reserve", book_balance: 80.1, shared: true },
  ],
  cash_unmapped: 0,
  ar_reason: null,
  ar_over_30: 160.25,
  ar_invoices: 3,
  ar_unmapped: 0,
  pnl_reason: "month_report_not_cached",
  pnl_income: null,
  pnl_expenses: null,
  pnl_net: null,
  pnl_partial: false,
};
const draw = (over: Record<string, unknown> = {}) => render(<FinanceCards laneId="PKG" view={toHomeFinance([{ ...row, ...over }])} />);

describe("FinanceCards", () => {
  it("shows three cards: Cash with the Book balance label and per-account lines, AR > 30 days, and P&L with its reason", () => {
    draw();
    const section = screen.getByTestId("home-finance");
    const cards = section.querySelectorAll("[data-slot=kpi-card]");
    expect(cards).toHaveLength(3);
    const cash = cards[0] as HTMLElement;
    expect(within(cash).getByText("Book balance")).toBeTruthy();
    expect(within(cash).getByText("$1,314.66")).toBeTruthy();
    const accounts = within(cash).getByTestId("cash-accounts");
    expect(within(accounts).getByText("Operating")).toBeTruthy();
    expect(within(accounts).getByText("Reserve (shared)")).toBeTruthy();
    expect(within(accounts).getByText("$1,234.56")).toBeTruthy();
    expect(cash.textContent).toContain("As of Nov 10, 3:00 PM ET");
    const ar = cards[1] as HTMLElement;
    expect(within(ar).getByText("$160.25")).toBeTruthy();
    expect(ar.textContent).toContain("3 open invoices");
    const pnl = cards[2] as HTMLElement;
    expect(pnl.textContent).toContain("The month-to-date report is not synced yet");
    expect(pnl.querySelector("[data-slot=kpi-value]")).toBeNull();
  });

  it("not connected: Connect QuickBooks in Settings, linking to Settings -> Connections", () => {
    render(<FinanceCards laneId="PKG" view={toHomeFinance([{ state: "not_connected" }])} />);
    expect(screen.getAllByText("Connect QuickBooks in Settings")).toHaveLength(3);
    const links = screen.getAllByRole("link", { name: "Open Settings" });
    expect(links[0]?.getAttribute("href")).toBe("/PKG/settings#connections");
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("connected, no data yet: the last sync time", () => {
    render(<FinanceCards laneId="PKG" view={toHomeFinance([{ state: "no_data", last_sync_at: "2026-11-11T20:00:00Z" }])} />);
    expect(screen.getAllByText("No QuickBooks data yet (last sync Nov 11, 3:00 PM ET)")).toHaveLength(3);
  });

  it("mapping missing: says so", () => {
    render(<FinanceCards laneId="PKG" view={toHomeFinance([{ state: "mapping_missing" }])} />);
    expect(screen.getAllByText(/entity mapping is missing/)).toHaveLength(3);
  });

  it("a role without finance access gets nothing drawn", () => {
    const { container } = render(<FinanceCards laneId="PKG" view={{ state: "no_access" }} />);
    expect(container.innerHTML).toBe("");
  });

  it("an outage is said, with no figures", () => {
    render(<FinanceCards laneId="PKG" view={{ state: "unavailable" }} />);
    expect(screen.getAllByText("Could not load QuickBooks figures. Reload in a minute.")).toHaveLength(3);
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("a connection that needs reconnecting adds a note with a link to Settings", () => {
    draw({ connection_status: "reconnect_required" });
    const note = screen.getByTestId("home-finance-note");
    expect(note.textContent).toMatch(/needs reconnecting/);
    expect(within(note).getByRole("link").getAttribute("href")).toBe("/PKG/settings#connections");
  });

  it("phone width: one column, two from sm, three from lg", () => {
    draw();
    const grid = screen.getByTestId("home-finance").querySelector("[data-slot=kpi-card]")?.parentElement;
    expect(grid?.className).toMatch(/grid-cols-1/);
    expect(grid?.className).toMatch(/sm:grid-cols-2/);
    expect(grid?.className).toMatch(/lg:grid-cols-3/);
  });
});
