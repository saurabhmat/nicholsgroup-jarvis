// @vitest-environment jsdom
// T-301: the Invoices & payments tab. Synthetic figures only (rule 10).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { toFinanceWeekly } from "@/lib/finance-reports";
import { WeeklyView, type WeeklyData } from "./finance-weekly";
import { weekly } from "./finance-reports.fixtures";

// Recharts measures its container with ResizeObserver, which jsdom does not have.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const draw = (d: WeeklyData = weekly()) => render(<WeeklyView laneId="PKG" laneName="Pub K Group" data={d} />);
const figures = (row: HTMLElement) => [...row.querySelectorAll("[data-field]")].map((c) => c.textContent?.replace(/\s+/g, " ").trim());

describe("Invoices & payments tab", () => {
  it("one row per business week, newest first: the current week to date, then the completed weeks; counts and amounts from SQL", () => {
    draw();
    const rows = screen.getAllByTestId("finance-week-row");
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.getAttribute("data-week"))).toEqual(["2026-11-21", "2026-11-14", "2026-11-07", "2026-10-31", "2026-10-24"]);
    expect(rows.map((r) => r.getAttribute("data-current"))).toEqual(["true", "false", "false", "false", "false"]);
    expect(figures(rows[0] as HTMLElement)).toEqual(["Nov 21, 2026 – Nov 27, 2026This week, to Nov 27, 2026", "Invoices issued2", "Invoiced$1,000.50", "Payments received1", "Received$100.00"]);
    expect(figures(rows[1] as HTMLElement).slice(1)).toEqual(["Invoices issued2", "Invoiced$500.00", "Payments received3", "Received$100.01"]);
    expect(figures(rows[3] as HTMLElement).slice(1)).toEqual(["Invoices issued0", "Invoiced$0.00", "Payments received0", "Received$0.00"]);
    expect(screen.getByText(/the 4 completed weeks before it/)).toBeTruthy();
  });

  it("has the grouped bar chart, hidden from a screen reader (the table carries the figures)", () => {
    draw();
    const chart = screen.getByTestId("finance-weekly-chart");
    expect(chart.getAttribute("aria-hidden")).toBe("true");
    expect(chart.closest("[aria-hidden='true']")).toBe(chart);
    expect(screen.getByTestId("finance-weekly-table").closest("[aria-hidden='true']")).toBeNull();
  });

  it("says what is not included", () => {
    draw();
    expect(screen.getByTestId("finance-weekly-not-included").textContent).toBe("Not included: sales receipts, credit memos and refunds are not synced. Payroll is excluded.");
  });

  it("each week is a link to ?week=<its Saturday>; no week chosen lists nothing", () => {
    draw();
    const links = screen.getAllByTestId("finance-week-row").map((r) => within(r).getByRole("link").getAttribute("href"));
    expect(links).toEqual(["/PKG/finance/weekly?week=2026-11-21", "/PKG/finance/weekly?week=2026-11-14", "/PKG/finance/weekly?week=2026-11-07", "/PKG/finance/weekly?week=2026-10-31", "/PKG/finance/weekly?week=2026-10-24"]);
    expect(screen.queryByTestId("finance-week-detail")).toBeNull();
  });

  it("a chosen week lists its invoices (customer, date, total, open balance) and its payments (customer, date, amount); its row links back to none", () => {
    draw(weekly({ week: "2026-11-14" }));
    const inv = screen.getAllByTestId("finance-week-invoice");
    expect(inv.map((i) => i.textContent)).toEqual(["Eps CoNov 14, 2026Total $300.00Open $0.00", "Gamma CoNov 20, 2026Total $200.00Open $20.00"]);
    const pay = screen.getAllByTestId("finance-week-payment");
    expect(pay.map((p) => p.textContent)).toEqual(["Delta CoNov 14, 2026$74.75", "Eps CoNov 20, 2026$0.01", "Unknown customerNov 20, 2026$25.25"]);
    const selected = screen.getAllByTestId("finance-week-row")[1] as HTMLElement;
    expect(within(selected).getByRole("link").getAttribute("href")).toBe("/PKG/finance/weekly");
    expect(within(selected).getByRole("link").getAttribute("aria-current")).toBe("true");
    expect(screen.queryByTestId("finance-week-cap")).toBeNull();
  });

  it("the caps are stated for invoices and payments", () => {
    draw(weekly({ week: "2026-11-14", detail: { invoice_count: 55, payment_count: 52 } }));
    const caps = screen.getAllByTestId("finance-week-cap").map((c) => c.textContent);
    expect(caps).toEqual(["Showing the first 2 of 55 invoices. The week's figures above count all of them.", "Showing the first 3 of 52 payments. The week's figures above count all of them."]);
  });

  it("an empty chosen week says so", () => {
    draw(weekly({ week: "2026-11-14", detail: { invoices: [], payments: [], invoice_count: 0, payment_count: 0 } }));
    expect(screen.getByTestId("finance-week-invoices-empty").textContent).toBe("No invoices issued this week.");
    expect(screen.getByTestId("finance-week-payments-empty").textContent).toBe("No payments received this week.");
  });

  it("a week the database does not accept (not a Saturday in range) shows nothing", () => {
    draw(weekly({ week: "2026-11-15", detail: { week_valid: false } }));
    expect(screen.queryByTestId("finance-week-detail")).toBeNull();
  });

  it("phone layout: rows are stacks that become a grid from md; every figure carries its own label", () => {
    draw();
    const row = screen.getAllByTestId("finance-week-row")[0] as HTMLElement;
    expect(row.className).toContain("flex-col");
    expect(row.className).toContain("md:grid");
    expect([...row.querySelectorAll("[data-field] > span:first-child")].filter((l) => l.className.includes("md:hidden"))).toHaveLength(4);
  });

  it("an outage of the chosen week's read says so, the weeks still show", () => {
    draw({ ...weekly({ week: "2026-11-14" }), detail: { state: "unavailable" } });
    expect(screen.getAllByTestId("finance-week-row")).toHaveLength(5);
    expect(screen.getByText("Chosen week")).toBeTruthy();
    expect(document.body.textContent).toContain("Could not load. Reload in a minute.");
  });

  it.each([
    ["not_connected", "Connect QuickBooks in Settings"],
    ["no_data", "No QuickBooks data yet"],
    ["mapping_missing", "entity mapping is missing"],
  ])("state %s: words that say what is needed, no figure", (state, words) => {
    draw({ weekly: toFinanceWeekly([{ state, last_sync_at: null, connection_status: null, weeks: [] }]), detail: { state: "none" }, week: null });
    expect(document.body.textContent).toContain(words);
    expect(document.body.textContent).not.toMatch(/\$\d/);
    expect(screen.queryByTestId("finance-weekly-chart")).toBeNull();
  });

  it("no access: no tabs, no figures; an outage says reload", () => {
    draw({ weekly: { state: "no_access" }, detail: { state: "none" }, week: null });
    expect(screen.getByText("No access to finance figures")).toBeTruthy();
    expect(screen.queryByTestId("finance-tabs")).toBeNull();
    cleanup();
    draw({ weekly: { state: "unavailable" }, detail: { state: "unavailable" }, week: null });
    expect(document.body.textContent).toContain("Could not load QuickBooks figures");
  });
});
