// @vitest-environment jsdom
// T-300: the Receivables tab. Synthetic figures only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ReceivablesView } from "./finance-receivables";
import { receivables } from "./finance-reports.fixtures";
import { toReceivables } from "@/lib/finance-reports";

afterEach(cleanup);

const draw = (data = receivables()) => render(<ReceivablesView laneId="PKG" laneName="Pub K Group" data={data} />);
const cells = (el: HTMLElement) => [...el.querySelectorAll("[data-bucket], [data-field='total'], [data-field='invoices']")].map((c) => c.textContent?.replace(/\s+/g, " ").trim());

describe("Receivables tab", () => {
  it("the tab row links the three tabs; Receivables is current; the row scrolls sideways inside its own box", () => {
    draw();
    const nav = screen.getByTestId("finance-tabs");
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/PKG/finance", "/PKG/finance/receivables", "/PKG/finance/weekly"]);
    expect(links.map((l) => l.getAttribute("aria-current"))).toEqual([null, "page", null]);
    expect(links.map((l) => l.textContent)).toEqual(["Overview", "Receivables", "Invoices & payments"]);
    expect(nav.className).toContain("overflow-x-auto");
    expect(links[0]?.className).toContain("whitespace-nowrap");
  });

  it("one row per customer by total, with the five buckets, the total and the number of open invoices, and a totals row from SQL", () => {
    draw();
    const rows = screen.getAllByTestId("finance-ar-row");
    expect(rows.map((r) => r.querySelector("[data-field='customer']")?.textContent?.replace("›", "").trim())).toEqual(["Alpha Co", "Beta Co", "Unknown customer"]);
    expect(cells(rows[0] as HTMLElement)).toEqual(["Current$0.00", "1–30$0.00", "31–60$200.20", "61–90$0.00", "90+$100.10", "Total$300.30", "Open invoices2"]);
    expect(cells(screen.getByTestId("finance-ar-total"))).toEqual(["Current$51.06", "1–30$0.00", "31–60$210.20", "61–90$0.00", "90+$100.10", "Total$361.36", "Open invoices5"]);
  });

  it("a customer's open invoices are inside its row, oldest first, with days overdue and balance; no invoice number, no customer id", () => {
    const { container } = draw();
    const first = screen.getAllByTestId("finance-ar-row")[0] as HTMLElement;
    const inv = within(first).getAllByTestId("finance-ar-invoice");
    expect(inv.map((i) => i.textContent)).toEqual([expect.stringContaining("Aug 1, 2026"), expect.stringContaining("Oct 1, 2026")]);
    expect(inv[0]?.textContent).toContain("95");
    expect(inv[0]?.textContent).toContain("$100.10");
    expect(inv[1]?.textContent).toContain("No due date");
    expect(container.querySelector("a[href*='customer']")).toBeNull();
    expect(container.innerHTML).not.toMatch(/customer_id|customerId|invoice number:/i);
    expect(screen.getByTestId("finance-ar-rule").textContent).toContain("Invoice numbers are not stored");
  });

  it("the check line shows the QuickBooks total with its date, the difference from SQL and the credits note", () => {
    draw();
    const c = screen.getByTestId("finance-ar-check").textContent ?? "";
    expect(c).toContain("QuickBooks AR aging report, as of Nov 27, 2026: $360.00");
    expect(screen.getByTestId("finance-ar-difference").textContent).toContain("$1.36");
    expect(c).toContain("Credit memos and unapplied credits are not synced");
  });

  it.each([
    ["not_cached", "not cached yet"],
    ["withheld", "withheld"],
    ["older_than_data", "older than the latest data"],
    ["unreadable", "could not be read"],
  ])("a check that is missing (%s) says the report total is not available and why; no figure", (reason, words) => {
    draw(receivables({ check_reason: reason, check_total: null, check_difference: null, check_report_date: null }));
    const c = screen.getByTestId("finance-ar-check").textContent ?? "";
    expect(c).toContain("the report total is not available");
    expect(c).toContain(words);
    expect(c).not.toMatch(/\$\d/);
  });

  it("the caps are stated: customers not shown and invoices not listed", () => {
    draw(receivables({ customer_count: 55, customers_shown: 3, customers: [{ name: "Alpha Co", current: 0, "1_30": 0, "31_60": 0, "61_90": 0, "90_plus": 5, total: 5, invoices: 29, detail_shown: 1, detail: [{ issue_date: "2026-08-01", due_date: null, days_overdue: 9, balance: 5 }] }] }));
    expect(screen.getByTestId("finance-ar-cap").textContent).toBe("Showing the 1 customers with the largest balances. 54 customers are not shown. The totals row counts all 55 customers.");
    expect(screen.getByTestId("finance-ar-detail-cap").textContent).toContain("Showing the 1 oldest of 29 open invoices");
  });

  it("no cap line when everything is shown", () => {
    draw();
    expect(screen.queryByTestId("finance-ar-cap")).toBeNull();
    expect(screen.queryByTestId("finance-ar-detail-cap")).toBeNull();
  });

  it("phone layout: rows are stacks (flex column) that become a grid from md; each figure carries its own label", () => {
    draw();
    const row = screen.getAllByTestId("finance-ar-row")[0] as HTMLElement;
    const summary = row.querySelector("summary") as HTMLElement;
    expect(summary.className).toContain("flex-col");
    expect(summary.className).toContain("md:grid");
    expect([...row.querySelectorAll("[data-bucket] > span:first-child")].every((l) => l.className.includes("md:hidden"))).toBe(true);
    expect(screen.getByTestId("finance-ar-table").parentElement?.className).toContain("min-w-0");
  });

  it("the connection note shows for a connection that needs attention", () => {
    draw(receivables({ connection_status: "reconnect_required" }));
    expect(screen.getByTestId("finance-connection-note").textContent).toContain("needs reconnecting");
  });

  it("no open invoices says so; no figure", () => {
    draw(receivables({ customers: [], customer_count: 0, customers_shown: 0, total: 0, invoice_count: 0 }));
    expect(screen.getByText("No open invoices")).toBeTruthy();
  });

  it.each([
    ["not_connected", "Connect QuickBooks in Settings"],
    ["no_data", "No QuickBooks data yet (last sync"],
    ["mapping_missing", "entity mapping is missing"],
  ])("state %s: words that say what is needed, no figure, tabs still there", (state, words) => {
    draw(toReceivables([{ state, as_of: null, last_sync_at: "2026-11-27T14:55:00Z", connection_status: "active", business_date: "2026-11-27", buckets: [], total: null, invoice_count: 0, customers: [], customer_count: 0 }]));
    expect(document.body.textContent).toContain(words);
    expect(document.body.textContent).not.toMatch(/\$\d/);
    expect(screen.getByTestId("finance-tabs")).toBeTruthy();
  });

  it("no access: no figures and no tabs; an outage says reload", () => {
    draw({ state: "no_access" });
    expect(screen.getByText("No access to finance figures")).toBeTruthy();
    expect(screen.queryByTestId("finance-tabs")).toBeNull();
    cleanup();
    draw({ state: "unavailable" });
    expect(document.body.textContent).toContain("Could not load QuickBooks figures");
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });
});
