// @vitest-environment jsdom
// T-244: the Finance page view. Synthetic figures only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { toHomeFinance } from "@/lib/home-finance";
import { toHomeFinanceDetail } from "@/lib/home-finance-detail";
import { toFinanceOverview, toFinancePnl, type FinancePeriod } from "@/lib/finance-page";
import { FinanceView, type FinanceData } from "./finance-page";

afterEach(cleanup);

const accounts = [
  { name: "Operating", book_balance: 1500.5, shared: false },
  { name: "Reserve", book_balance: 500.5, shared: true },
];
const okRow = {
  state: "ok", as_of: "2026-11-14T12:00:00Z", last_sync_at: "2026-11-14T11:55:00Z", connection_status: "active",
  cash_reason: null, cash_total: 2001, cash_as_of: "2026-11-14T11:55:00Z", cash_accounts: accounts, cash_unmapped: 1,
  ar_reason: null, ar_over_30: 160.25, ar_invoices: 3, ar_unmapped: 0,
  pnl_reason: null, pnl_income: 1000, pnl_expenses: 400, pnl_net: 600, pnl_start: "2026-11-01", pnl_end: "2026-11-14", pnl_method: "accrual", pnl_partial: false, pnl_as_of: null,
};
const aging = [
  { bucket: "current", total: 400, count: 2 }, { bucket: "1_30", total: 200, count: 1 }, { bucket: "31_60", total: 100, count: 1 }, { bucket: "61_90", total: 50, count: 1 }, { bucket: "90_plus", total: 0, count: 0 },
];
const detailRow = { state: "ok", as_of: "2026-11-14T12:00:00Z", bills_due_14_total: 410.5, bills_due_14_count: 2, aging, oldest: [], unmapped_invoices: 2, unmapped_bills: 0 };
const pnlRow = {
  state: "ok", as_of: "2026-11-14T12:00:00Z", last_sync_at: "2026-11-14T11:55:00Z", connection_status: "active", period: "mtd", window_start: "2026-11-01", window_end: "2026-11-14",
  pnl_reason: null, pnl_income: 1000, pnl_expenses: 400, pnl_net: 600, pnl_start: "2026-11-01", pnl_end: "2026-11-14", pnl_method: "accrual", pnl_partial: true, pnl_as_of: "2026-11-14T11:00:00Z",
};
const overviewRow = {
  state: "ok", as_of: "2026-11-14T12:00:00Z", last_sync_at: "2026-11-14T11:55:00Z", last_normalized_at: "2026-11-14T11:58:00Z", connection_status: "active", ar_total: 750, ar_invoices: 5, unmapped_bills_open: 1,
  reports: [{ report: "pnl", start_date: "2026-11-01", end_date: "2026-11-14", report_date: null, method: "accrual", class_filtered: false, as_of: "2026-11-14T11:00:00Z" }],
};

function data(over: { finance?: Record<string, unknown>; detail?: Record<string, unknown>; pnl?: Record<string, unknown>; overview?: Record<string, unknown> } = {}, period: FinancePeriod = "mtd"): FinanceData {
  return {
    finance: toHomeFinance([{ ...okRow, ...over.finance }]),
    detail: toHomeFinanceDetail([{ ...detailRow, ...over.detail }]),
    pnl: toFinancePnl([{ ...pnlRow, ...over.pnl }], period),
    overview: toFinanceOverview([{ ...overviewRow, ...over.overview }]),
  };
}
const draw = (d = data(), period: FinancePeriod = "mtd") => render(<FinanceView laneId="PKG" laneName="Pub K Group" period={period} data={d} />);
const card = (name: string) => screen.getByRole("heading", { name }).closest("[data-slot='kpi-card']") as HTMLElement;

describe("Finance page, live figures", () => {
  it("the four cards come from the same SQL figures as Home", () => {
    draw();
    expect(card("Cash").textContent).toContain("$2,001.00");
    expect(card("Cash").textContent).toMatch(/book balance/i);
    expect(card("Cash").textContent).toContain("Excludes 1 unmapped account");
    expect(card("Accounts receivable").textContent).toContain("$750.00");
    expect(card("Accounts receivable").textContent).toContain("equals the receivables aging total");
    expect(card("Accounts receivable").textContent).toContain("Excludes 2 invoices with no company");
    expect(card("Bills due in 14 days").textContent).toContain("$410.50");
    expect(card("Bills due in 14 days").textContent).toContain("2 bills");
    expect(card("Net income").textContent).toContain("$600.00");
    expect(card("Net income").textContent).toContain("Income $1,000.00 · Expenses $400.00");
    expect(card("Net income").textContent).toContain("Excludes payroll accounts");
    expect(card("Net income").textContent).toContain("Month to date");
    expect(card("Net income").textContent).toContain("Nov 1, 2026 – Nov 14, 2026");
  });

  it("the period toggle is links with ?period; the selected one is current; the default has no query", () => {
    draw(data({}, "ytd"), "ytd");
    const nav = screen.getByTestId("finance-period");
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/PKG/finance?period=week", "/PKG/finance", "/PKG/finance?period=ytd"]);
    expect(links.map((l) => l.getAttribute("aria-current"))).toEqual([null, null, "page"]);
    expect(card("Net income").textContent).toContain("Year to date");
  });

  it("a week period names the week", () => {
    draw(data({ pnl: { period: "week", window_start: "2026-11-14", window_end: "2026-11-14" } }, "week"), "week");
    expect(card("Net income").textContent).toContain("This week (Sat–Fri)");
    expect(card("Net income").textContent).toContain("Nov 14, 2026");
  });

  it("a P&L that is not synced yet says so; no number", () => {
    draw(data({ pnl: { pnl_reason: "report_not_cached", pnl_net: null, pnl_income: null, pnl_expenses: null, pnl_start: null, pnl_end: null } }));
    const c = card("Net income");
    expect(c.textContent).toContain("not synced yet");
    expect(c.textContent).not.toMatch(/\$\d/);
  });

  it("receivables aging: five buckets and a total that is the SQL total", () => {
    draw();
    const sec = screen.getByTestId("finance-aging");
    expect([...sec.querySelectorAll("[data-bucket]")].map((e) => e.getAttribute("data-bucket"))).toEqual(["current", "1_30", "31_60", "61_90", "90_plus"]);
    expect(within(sec).getByTestId("finance-aging-total").textContent).toBe("$750.00");
  });

  it("cash by account: each own account with its book balance, a shared flag and the last sync; unmapped counted, not listed", () => {
    draw();
    const rows = screen.getAllByTestId("finance-cash-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Operating");
    expect(rows[0]?.textContent).toContain("$1,500.50");
    expect(rows[0]?.textContent).toContain("Last sync Nov 14, 6:55 AM ET");
    expect(rows[0]?.textContent).not.toContain("Shared account");
    expect(rows[1]?.textContent).toContain("Shared account");
    expect(screen.getByRole("region", { name: "Cash by account" }).textContent).toContain("1 bank account is not mapped to a company");
    expect(screen.getByRole("region", { name: "Cash by account" }).textContent).toMatch(/Book balance/i);
  });

  it("controls: what exists, with an honest line for what is missing", () => {
    draw();
    const list = screen.getByTestId("finance-controls");
    expect(list.querySelector("[data-control='quickbooks_connection']")?.textContent).toContain("Connected");
    expect(list.querySelector("[data-control='unmapped_bank_accounts']")?.getAttribute("data-status")).toBe("warn");
    expect(list.querySelector("[data-control='shared_bank_account']")?.textContent).toContain("Reserve");
    expect(screen.getByTestId("finance-controls-missing").textContent).toMatch(/Reconciliation, bank feed health/);
  });

  it("reports: cached reports (type, range, cache time) and the missing weekly and month-end reports", () => {
    draw();
    const rows = screen.getAllByTestId("finance-report-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Profit and loss");
    expect(rows[0]?.textContent).toContain("Cached Nov 14, 6:00 AM ET");
    expect(screen.getByTestId("finance-reports-missing").textContent).toMatch(/weekly cash report/);
  });

  it("subscriptions keep the current empty message", () => {
    draw();
    expect(screen.getByRole("region", { name: "Subscriptions" }).textContent).toContain("No subscription data yet");
  });
});

describe("Finance page, non-ok states", () => {
  const states = {
    not_connected: "Connect QuickBooks in Settings",
    mapping_missing: "entity mapping is missing",
    no_data: "No QuickBooks data yet",
  } as const;
  for (const [state, wording] of Object.entries(states)) {
    it(`${state}: every card and section says so, with no figure`, () => {
      const blank = { as_of: null, last_sync_at: null };
      draw(data({ finance: { state, ...blank }, detail: { state }, pnl: { state }, overview: { state } }));
      expect(card("Cash").textContent).toContain(wording);
      expect(card("Net income").textContent).toContain(wording);
      expect(screen.getByRole("region", { name: "Controls" }).textContent).toContain(wording);
      expect(screen.getByRole("region", { name: "Reports" }).textContent).toContain(wording);
      expect(document.body.textContent).not.toMatch(/\$\d/);
    });
  }

  it("no_access: no figures, no toggle, a plain message", () => {
    draw({ finance: { state: "no_access" }, detail: { state: "no_access" }, pnl: { state: "no_access" }, overview: { state: "no_access" } });
    expect(screen.getByText("No access to finance figures")).toBeTruthy();
    expect(screen.queryByTestId("finance-period")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it("an outage is one honest line per card; no invented figure", () => {
    draw({ finance: { state: "unavailable" }, detail: { state: "unavailable" }, pnl: { state: "unavailable" }, overview: { state: "unavailable" } });
    expect(card("Cash").textContent).toContain("Could not load");
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it("the cash reasons use Home's words", () => {
    draw(data({ finance: { cash_reason: "bank_mapping_missing", cash_total: null, cash_accounts: [] } }));
    expect(card("Cash").textContent).toContain("Bank accounts are not mapped to this company yet");
    expect(screen.getByRole("region", { name: "Cash by account" }).textContent).toContain("Bank accounts are not mapped to this company yet");
  });

  it("a reconnect-required connection is noted", () => {
    draw(data({ finance: { connection_status: "reconnect_required" } }));
    expect(screen.getByTestId("finance-connection-note").textContent).toMatch(/needs reconnecting/);
  });
});
