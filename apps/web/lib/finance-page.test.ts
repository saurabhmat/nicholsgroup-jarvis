// T-244: mapping and wording of the Finance page reads. Synthetic figures only (rule 10).
import { describe, expect, it, vi } from "vitest";
import { CONTROLS_MISSING, controlRows, financeOverviewFor, financePnlFor, formatRange, parsePeriod, pnlReasonText, reportLine, toFinanceOverview, toFinancePnl } from "./finance-page";

const pnlRow = {
  state: "ok", as_of: "2026-11-14T07:00:00Z", last_sync_at: "2026-11-14T06:50:00Z", connection_status: "active", period: "mtd",
  window_start: "2026-11-01", window_end: "2026-11-14", pnl_reason: null, pnl_income: "1000.00", pnl_expenses: 300, pnl_net: "700.00",
  pnl_start: "2026-11-01", pnl_end: "2026-11-14", pnl_method: "accrual", pnl_partial: false, pnl_as_of: "2026-11-14T07:01:00Z",
};

describe("parsePeriod", () => {
  it("accepts the three keys and falls back to month to date for anything else", () => {
    expect(parsePeriod("week")).toBe("week");
    expect(parsePeriod("mtd")).toBe("mtd");
    expect(parsePeriod("ytd")).toBe("ytd");
    for (const v of [undefined, "", "quarter", "YTD", ["ytd", "week"], 5, null, "mtd; drop table"]) expect(parsePeriod(v)).toBe("mtd");
  });
});

describe("toFinancePnl", () => {
  it("maps the row; numerics may be strings", () => {
    const v = toFinancePnl([pnlRow], "mtd");
    expect(v).toMatchObject({ state: "ok", period: "mtd", windowStart: "2026-11-01", windowEnd: "2026-11-14", reason: null, income: 1000, expenses: 300, net: 700, method: "accrual", partial: false });
  });
  it("fails closed: no row, unknown state or no_access give no_access", () => {
    expect(toFinancePnl(null, "ytd")).toEqual({ state: "no_access" });
    expect(toFinancePnl([], "ytd")).toEqual({ state: "no_access" });
    expect(toFinancePnl([{ state: "bogus" }], "ytd")).toEqual({ state: "no_access" });
    expect(toFinancePnl([{ state: "no_access" }], "ytd")).toEqual({ state: "no_access" });
  });
  it("a reason carries no figure; junk dates and numbers become null", () => {
    const v = toFinancePnl([{ ...pnlRow, pnl_reason: "report_not_cached", pnl_net: null, pnl_income: "x", window_start: "not a date" }], "week");
    expect(v).toMatchObject({ reason: "report_not_cached", net: null, income: null, windowStart: null });
  });
});

describe("reason wording", () => {
  it("every SQL reason has honest text; unknown reasons get a safe default", () => {
    expect(pnlReasonText("report_not_cached")).toMatch(/not synced yet/);
    expect(pnlReasonText("report_empty")).toMatch(/No income or expense lines/);
    expect(pnlReasonText("something_new")).toBe("Not available yet");
  });
});

describe("toFinanceOverview", () => {
  const row = {
    state: "ok", as_of: "2026-11-14T07:00:00Z", last_sync_at: "2026-11-14T06:50:00Z", last_normalized_at: "2026-11-14T06:55:00Z", connection_status: "active",
    ar_total: "5281.52", ar_invoices: 20, unmapped_bills_open: 1,
    reports: [
      { report: "pnl", start_date: "2026-11-01", end_date: "2026-11-14", report_date: null, method: "accrual", class_filtered: false, as_of: "2026-11-14T07:01:00Z" },
      { report: "ar_aging_summary", start_date: null, end_date: null, report_date: "2026-11-14", method: null, class_filtered: false, as_of: "2026-11-14T07:02:00Z" },
      { report: "", as_of: "2026-11-14T07:02:00Z" },
      { report: "pnl", as_of: "garbage" },
      "junk",
    ],
  };
  it("maps the row and drops junk report entries", () => {
    const v = toFinanceOverview([row]);
    if (v.state !== "ok") throw new Error("state");
    expect(v).toMatchObject({ arTotal: 5281.52, arInvoices: 20, unmappedBillsOpen: 1, lastNormalizedAt: "2026-11-14T06:55:00.000Z" });
    expect(v.reports).toHaveLength(2);
  });
  it("fails closed", () => {
    expect(toFinanceOverview([])).toEqual({ state: "no_access" });
    expect(toFinanceOverview([{ state: "no_access" }])).toEqual({ state: "no_access" });
  });
  it("report lines show range, basis and cache time, never figures", () => {
    const v = toFinanceOverview([row]);
    if (v.state !== "ok") throw new Error("state");
    expect(reportLine(v.reports[0] as never)).toEqual({ title: "Profit and loss", covers: "Nov 1, 2026 – Nov 14, 2026 · Accrual basis", cached: "Cached Nov 14, 2:01 AM ET" });
    expect(reportLine(v.reports[1] as never)).toMatchObject({ title: "Receivables aging (AR)", covers: "As of Nov 14, 2026" });
    expect(formatRange("2026-11-14", "2026-11-14")).toBe("Nov 14, 2026");
  });
});

describe("controlRows", () => {
  const base = { connectionStatus: "active", lastSyncAt: "2026-11-14T06:50:00Z", lastNormalizedAt: "2026-11-14T06:55:00Z", unmappedBankAccounts: 0, unmappedInvoices: 0, unmappedBills: 0, sharedAccountNames: [] };
  it("all clear", () => {
    const rows = controlRows(base);
    expect(rows.every((r) => r.status === "ok")).toBe(true);
    expect(rows.map((r) => r.key)).toEqual(["quickbooks_connection", "last_sync", "last_processed", "unmapped_bank_accounts", "unmapped_invoices", "unmapped_bills", "shared_bank_account"]);
  });
  it("problems are flagged with plain words", () => {
    const rows = controlRows({ ...base, connectionStatus: "reconnect_required", lastSyncAt: null, lastNormalizedAt: null, unmappedBankAccounts: 2, unmappedInvoices: 1, unmappedBills: 3, sharedAccountNames: ["Reserve"] });
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.quickbooks_connection).toMatchObject({ status: "warn", text: "Needs reconnecting" });
    expect(by.last_sync).toMatchObject({ status: "warn", text: "Not synced yet" });
    expect(by.last_processed).toMatchObject({ status: "warn", text: "Not processed yet" });
    expect(by.unmapped_bank_accounts?.text).toBe("2 accounts");
    expect(by.unmapped_invoices?.text).toBe("1 invoice");
    expect(by.unmapped_bills?.text).toBe("3 bills");
    expect(by.shared_bank_account).toMatchObject({ status: "warn", text: "Reserve" });
  });
  it("a check whose source failed to load is left out; the missing checks are stated", () => {
    expect(controlRows({ ...base, unmappedInvoices: null, unmappedBills: null }).map((r) => r.key)).not.toContain("unmapped_invoices");
    expect(CONTROLS_MISSING).toMatch(/Reconciliation/);
  });
});

describe("loading", () => {
  const g = (client: unknown) => ({ requireLane: async () => ({ client }) }) as never;
  it("calls finance_pnl with the lane and the period", async () => {
    const rpc = vi.fn(async () => ({ data: [pnlRow], error: null }));
    const v = await financePnlFor(g({ schema: () => ({ rpc }) }), "PKG", "week");
    expect(rpc).toHaveBeenCalledWith("finance_pnl", { p_lane: "PKG", p_period: "week" });
    expect(v.state).toBe("ok");
  });
  it("an outage is 'unavailable', never an empty figure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bad = g({ schema: () => ({ rpc: async () => ({ data: null, error: { message: "boom" } }) }) });
    expect(await financePnlFor(bad, "PKG", "ytd")).toEqual({ state: "unavailable" });
    expect(await financeOverviewFor(bad, "PKG")).toEqual({ state: "unavailable" });
  });
});
