// @vitest-environment jsdom
// T-302: the Cash tab. Synthetic figures only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { CashView, formatChange } from "./finance-cash";
import { cash } from "./finance-reports.fixtures";
import type { FinanceCash } from "@/lib/finance-reports";

afterEach(cleanup);
const draw = (d: FinanceCash = cash()) => render(<CashView laneId="PKG" laneName="Pub K Group" data={d} />);
const flat = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
const cellsOf = (row: HTMLElement) => [...row.querySelectorAll("[role='cell']")].map((c) => flat(c));

describe("Cash tab", () => {
  it("the tab row has Cash second and current", () => {
    draw();
    const links = within(screen.getByTestId("finance-tabs")).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href"), l.getAttribute("aria-current")])).toEqual([
      ["Overview", "/PKG/finance", null], ["Cash", "/PKG/finance/cash", "page"], ["Receivables", "/PKG/finance/receivables", null], ["Invoices & payments", "/PKG/finance/weekly", null],
    ]);
  });

  it("one row per bank account with a book balance and its change per column, today first; the shared flag; a total row", () => {
    draw();
    const rows = screen.getAllByTestId("finance-cash-account-row");
    expect(rows).toHaveLength(2);
    expect(flat(rows[0] as HTMLElement)).toContain("Operating Checking");
    expect(cellsOf(rows[0] as HTMLElement)).toEqual([
      "Today$1,000.50+$99.50 vs. the older column",
      "Fri Nov 20, 2026$901.00+$101.00 vs. the older column",
      "Fri Nov 13, 2026$800.00",
      "Fri Nov 6, 2026Not read yet",
    ]);
    expect(flat(rows[1] as HTMLElement)).toContain("Shared account");
    expect(cellsOf(rows[1] as HTMLElement)).toEqual([
      "Today$2,000.25-$100.00 vs. the older column",
      "Fri Nov 20, 2026$2,100.25No change vs. the older column",
      "Fri Nov 13, 2026Not available",
      "Fri Nov 6, 2026Not read yet",
    ]);
  });

  it("the total row: a column with a missing account has no total, not a partial sum", () => {
    draw();
    const total = screen.getByTestId("finance-cash-total-row");
    expect(flat(total)).toContain("Total book balance");
    expect(cellsOf(total)).toEqual([
      "Today$3,000.75+$99.50 vs. the older column",
      "Fri Nov 20, 2026$3,001.25",
      "Fri Nov 13, 2026Not complete1 account has no balance",
      "Fri Nov 6, 2026Not read yet",
    ]);
    expect(total.textContent).not.toContain("$800.00"); // 800 alone is the partial sum SQL refused to give
  });

  it("column headings carry their as-of; an unread week end says so, and the page says how many were not read", () => {
    draw();
    const heads = [...screen.getByTestId("finance-cash-table").querySelectorAll("[role='columnheader']")].map((h) => flat(h));
    expect(heads[0]).toBe("Bank account");
    expect(heads[1]).toBe("TodayBooks synced Nov 27, 9:55 AM ET");
    expect(heads[2]).toBe("Fri Nov 20, 2026Read Nov 27, 2:00 AM ET");
    expect(heads[4]).toBe("Fri Nov 6, 2026Not read yet");
    expect(screen.getByTestId("finance-cash-unread").textContent).toContain("1 week end has not been read from QuickBooks yet");
  });

  it("a column that has not been read at all says Not read yet in the total row too (not N accounts missing)", () => {
    draw();
    const total = screen.getByTestId("finance-cash-total-row");
    expect(total.textContent).not.toContain("2 accounts have no balance");
    expect(cellsOf(total)[3]).toBe("Fri Nov 6, 2026Not read yet");
  });

  it("says that a not available balance can be a zero balance, a later account or a parent, and that closed accounts are not listed", () => {
    draw();
    const note = screen.getByTestId("finance-cash-missing-note").textContent ?? "";
    expect(note).toContain("zero balance");
    expect(note).toContain("opened later");
    expect(note).toContain("parent account with sub-accounts");
    expect(note).toContain("Accounts closed since are not listed, so earlier totals cover today's accounts only");
  });

  it("history switched off: the Today column only, with the sentence that says so; no week columns, no unread or missing notes", () => {
    const v = cash({ history_enabled: false, weeks: 4, columns: [{ kind: "today", date: "2026-11-27", as_of: "2026-11-27T14:55:00Z", read: 2, accounts: 2 }],
      accounts: [{ name: "Operating Checking", shared: false, cells: [{ book_balance: 1000.5, change: null }] }, { name: "Savings", shared: true, cells: [{ book_balance: 2000.25, change: null }] }],
      totals: [{ book_balance: 3000.75, change: null, missing: 0 }] });
    draw(v);
    expect(screen.getByTestId("finance-cash-history-off").textContent).toBe("Weekly history is not switched on for this company. Today's book balances are shown.");
    expect(within(screen.getByTestId("finance-cash-total-row")).getByText("$3,000.75")).toBeTruthy();
    expect(screen.queryByTestId("finance-cash-unread")).toBeNull();
    expect(screen.queryByTestId("finance-cash-missing-note")).toBeNull();
    expect([...screen.getByTestId("finance-cash-table").querySelectorAll("[role='columnheader']")]).toHaveLength(2);
  });

  it("says book balance, never bank balance; money in and out is not shown; payroll accounts are not listed", () => {
    draw();
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/book balance/i);
    expect(body).not.toMatch(/bank balance/i);
    const note = screen.getByTestId("finance-cash-note").textContent ?? "";
    expect(note).toContain("The change is the difference of two book balances");
    expect(note).toContain("money in and out is not shown");
    expect(note).toContain("Payroll accounts are not listed");
  });

  it("table roles: a table with column headers, row headers and cells (reachable by role)", () => {
    draw();
    const table = screen.getByRole("table", { name: /Book balance by bank account/ });
    expect(within(table).getAllByRole("columnheader").length).toBe(5);
    expect(within(table).getAllByRole("rowheader").length).toBe(3);
    expect(within(table).getAllByRole("row").length).toBe(4);
  });

  it("phone layout: rows stack (flex column) and each cell carries its own column label; the grid applies from md", () => {
    draw();
    const row = screen.getAllByTestId("finance-cash-account-row")[0] as HTMLElement;
    expect(row.className).toContain("flex-col");
    expect(row.className).toContain("md:grid");
    const labels = [...row.querySelectorAll("[role='cell'] > span.md\\:hidden")].map((l) => l.textContent);
    expect(labels).toEqual(["Today", "Fri Nov 20, 2026", "Fri Nov 13, 2026", "Fri Nov 6, 2026"]);
    expect(screen.getByTestId("finance-cash-table").getAttribute("style")).toContain("--cash-cols: 4");
    expect(screen.getByTestId("finance-cash-table").parentElement?.className).toContain("md:overflow-x-auto");
  });

  it("the states say what is needed and show no figure", () => {
    for (const [state, text] of [["not_connected", "Connect QuickBooks"], ["no_data", "No QuickBooks data yet"], ["mapping_missing", "entity mapping is missing"]] as const) {
      cleanup();
      draw(cash({ state }));
      expect(document.body.textContent).toContain(text);
      expect(screen.queryByTestId("finance-cash-table")).toBeNull();
      expect(document.body.textContent).not.toMatch(/\$\d/);
    }
  });

  it("the reasons: unmapped bank accounts say what to do, no figure", () => {
    draw(cash({ reason: "bank_mapping_missing", columns: [], accounts: [], totals: [] }));
    expect(document.body.textContent).toContain("No bank accounts are mapped to a company yet");
    expect(screen.queryByTestId("finance-cash-table")).toBeNull();
    cleanup();
    draw(cash({ reason: "no_own_bank_accounts", columns: [], accounts: [], totals: [] }));
    expect(document.body.textContent).toContain("No bank account is mapped to this company");
  });

  it("no access shows no tabs and no figure; an outage says so", () => {
    draw({ state: "no_access" });
    expect(screen.queryByTestId("finance-tabs")).toBeNull();
    expect(document.body.textContent).toContain("No access to finance figures");
    cleanup();
    draw({ state: "unavailable" });
    expect(document.body.textContent).toContain("Could not load");
    expect(screen.queryByTestId("finance-cash-table")).toBeNull();
  });

  it("an unreadable account row: said, and no total is shown", () => {
    draw(cash({ accounts: [{ name: "Operating Checking", shared: false, cells: [{ book_balance: 1, change: null }] }, { name: "B", shared: false, cells: [{ book_balance: 1, change: null }, { book_balance: 1, change: null }, { book_balance: 1, change: null }, { book_balance: 1, change: null }] }] }));
    expect(screen.queryByTestId("finance-cash-total-row")).toBeNull();
    expect(screen.getByTestId("finance-cash-no-total").textContent).toContain("1 account row could not be read, so no total is shown");
  });
});

describe("formatChange", () => {
  it("signs the SQL difference", () => {
    expect(formatChange(99.5)).toBe("+$99.50");
    expect(formatChange(-20)).toBe("-$20.00");
    expect(formatChange(0)).toBe("No change");
  });
});
