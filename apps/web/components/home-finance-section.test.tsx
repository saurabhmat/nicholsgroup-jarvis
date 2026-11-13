// @vitest-environment jsdom
// T-237 part C: the Finance section. Synthetic figures only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { toHomeFinance } from "@/lib/home-finance";
import { toHomeFinanceDetail } from "@/lib/home-finance-detail";
import { HomeFinanceSection } from "./home-finance-section";

afterEach(cleanup);

const okRow = {
  state: "ok", as_of: "2026-11-11T20:00:00Z", last_sync_at: "2026-11-11T19:55:00Z", connection_status: "active",
  cash_reason: null, cash_total: 1314.66, cash_as_of: null, cash_accounts: [], cash_unmapped: 0,
  ar_reason: null, ar_over_30: 160.25, ar_invoices: 3, ar_unmapped: 0,
  pnl_reason: null, pnl_income: 1000, pnl_expenses: 400, pnl_net: 600, pnl_start: "2026-11-01", pnl_end: "2026-11-11", pnl_method: "accrual", pnl_partial: false, pnl_as_of: null,
};
const aging = [
  { bucket: "current", total: 400, count: 2 }, { bucket: "1_30", total: 200, count: 1 }, { bucket: "31_60", total: 100, count: 1 }, { bucket: "61_90", total: 50, count: 1 }, { bucket: "90_plus", total: 0, count: 0 },
];
const detailRow = { state: "ok", as_of: "2026-11-11T20:00:00Z", bills_due_14_total: 10, bills_due_14_count: 1, aging, oldest: [{ customer: "Customer A", balance: 30.5, days_overdue: 94 }, { customer: null, balance: 12, days_overdue: 1 }], unmapped_invoices: 2, unmapped_bills: 0 };
const fin = (over: Record<string, unknown> = {}) => toHomeFinance([{ ...okRow, ...over }]);
const det = (over: Record<string, unknown> = {}) => toHomeFinanceDetail([{ ...detailRow, ...over }]);
const draw = (finance = fin(), detail = det()) => render(<HomeFinanceSection laneId="PKG" finance={finance} detail={detail} />);

describe("Finance section", () => {
  it("title, 'QuickBooks, book figures as of <time ET>' and the Open Finance link", () => {
    draw();
    const s = screen.getByRole("region", { name: "Finance" });
    expect(within(s).getByTestId("finance-as-of").textContent).toBe("\u00b7 QuickBooks, book figures as of Nov 11, 3:00 PM ET");
    expect(within(s).getByRole("link", { name: /Open Finance/ }).getAttribute("href")).toBe("/PKG/finance");
    expect(s.textContent).not.toMatch(/Z\b|T\d\d:\d\d/);
  });

  it("month to date: 'Income' (never 'Revenue'), Expenses, proportional bars and Net income in the success token", () => {
    draw();
    const mtd = screen.getByTestId("finance-mtd");
    expect(mtd.textContent).toContain("November to date");
    expect(mtd.textContent).toContain("Income");
    expect(mtd.textContent).not.toContain("Revenue");
    expect(mtd.textContent).toContain("$1,000.00");
    expect(mtd.textContent).toContain("$400.00");
    const fills = [...mtd.querySelectorAll<HTMLElement>("[aria-hidden] > div")].map((e) => e.style.width);
    expect(fills).toEqual(["100%", "40%"]);
    expect(screen.getByTestId("finance-net").textContent).toBe("$600.00");
    expect(screen.getByTestId("finance-net").className).toContain("text-success");
  });

  it("a negative net income uses the danger token", () => {
    draw(fin({ pnl_net: -50, pnl_income: 100, pnl_expenses: 150 }));
    expect(screen.getByTestId("finance-net").className).toContain("text-danger");
  });

  it("receivables aging: five buckets in order with their amounts; 90+ at zero has an empty bar", () => {
    draw();
    const rows = [...screen.getByTestId("finance-aging").querySelectorAll("li")];
    expect(rows.map((r) => r.textContent)).toEqual(["Current$400.00", "1\u201330$200.00", "31\u201360$100.00", "61\u201390$50.00", "90+$0.00"]);
    expect([...rows].map((r) => (r.querySelector("[aria-hidden] > div") as HTMLElement).style.width)).toEqual(["100%", "50%", "25%", "13%", "0%"]);
    expect(screen.getByTestId("finance-aging").textContent).toContain("Excludes 2 invoices with no company");
  });

  it("oldest unpaid invoices: customer, amount, 'N days overdue' (singular for 1); the customer line is hidden when null", () => {
    draw();
    const rows = screen.getAllByTestId("finance-oldest-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByTestId("finance-oldest-customer").textContent).toBe("Customer A");
    expect(rows[0]?.textContent).toContain("94 days overdue");
    expect(rows[0]?.textContent).toContain("$30.50");
    expect(within(rows[1] as HTMLElement).queryByTestId("finance-oldest-customer")).toBeNull();
    expect(rows[1]?.textContent).toContain("1 day overdue");
  });

  it("no overdue invoices says so", () => {
    draw(fin(), det({ oldest: [] }));
    expect(screen.getByTestId("finance-oldest").textContent).toContain("No overdue invoices");
  });

  it("hidden when QuickBooks is not connected and for a role without the finance view", () => {
    const a = render(<HomeFinanceSection laneId="PKG" finance={toHomeFinance([{ state: "not_connected" }])} detail={det()} />);
    expect(a.container.firstChild).toBeNull();
    a.unmount();
    const b = render(<HomeFinanceSection laneId="PKG" finance={{ state: "no_access" }} detail={{ state: "no_access" }} />);
    expect(b.container.firstChild).toBeNull();
  });

  it("an unavailable read is one muted line; a missing detail leaves the other columns' notes", () => {
    const a = render(<HomeFinanceSection laneId="PKG" finance={{ state: "unavailable" }} detail={{ state: "unavailable" }} />);
    expect(screen.getByTestId("finance-unavailable").textContent).toMatch(/could not be loaded/);
    a.unmount();
    draw(fin(), { state: "unavailable" });
    expect(screen.getByTestId("finance-aging").textContent).toContain("Could not load");
    expect(screen.getByTestId("finance-mtd").textContent).toContain("$600.00");
  });

  it("a report that is not synced yet says why instead of showing bars", () => {
    draw(fin({ pnl_reason: "month_report_not_cached", pnl_income: null, pnl_expenses: null, pnl_net: null }));
    expect(screen.getByTestId("finance-mtd").textContent).toContain("The month-to-date report is not synced yet");
  });
});
