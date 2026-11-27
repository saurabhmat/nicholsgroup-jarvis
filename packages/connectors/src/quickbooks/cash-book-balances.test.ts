/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index into synthetic data they just built */
// T-302: cash-account book balances from the Balance Sheet. Unit tests of the planning and of the strict projection on SYNTHETIC reports (a payroll row,
// equity and net income, a nested sub-account, a row without an id, an oversized report) and job tests over the fake Intuit (MSW) and the harness
// twins. Nothing here was verified against Intuit. The database side is in supabase/core/supabase/tests/341_finance_cash.test.sql. The fixed instants and Fridays of the `cashHistoryDates` tests below are the SAME as in that file (core.business_week_start): keep the two lists equal.
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { useMockServer } from "../testing/msw/index";
import { createFakeIntuit } from "../testing/msw/quickbooks/handlers";
import { syntheticData, syntheticReportAccounts } from "../testing/msw/quickbooks/fixtures";
import { createQboHarness, type QboHarness } from "../testing/quickbooks-harness";
import type { QboConnection } from "./guard";
import { cashHistoryDates, planBalanceSheetAt, projectCashBookBalances, type BalanceSheetRequest } from "./cash-book-balances";

const server = useMockServer();
const LANE = "PKG";
afterEach(() => RateLimiter.resetForTests());

// ---------------------------------------------------------------- synthetic Balance Sheets
const cd = (value: string, id?: string) => ({ value, ...(id ? { id } : {}) });
const data = (label: string, id: string | undefined, figure: string) => ({ type: "Data", ColData: [cd(label, id), cd(figure)] });
const sec = (title: string, id: string | undefined, rows: unknown[], total: string, totalId?: string) => ({
  type: "Section",
  Header: { ColData: [cd(title, id), cd("")] },
  Rows: { Row: rows },
  Summary: { ColData: [cd(`Total ${title}`, totalId), cd(total)] },
});
const DATE = "2026-11-20";
const req: BalanceSheetRequest = planBalanceSheetAt(DATE, "accrual");
const report = (rows: unknown[], header: Record<string, unknown> = {}) => ({
  Header: { Time: "2026-11-27T10:00:00Z", ReportName: "BalanceSheet", ReportBasis: "Accrual", StartPeriod: DATE, EndPeriod: DATE, Currency: "USD", ...header },
  Columns: { Column: [{ ColTitle: "", ColType: "Account" }, { ColTitle: "Total", ColType: "Money" }] },
  Rows: { Row: rows },
});
const ids = (...xs: string[]) => new Set(xs);
const text = (v: unknown) => JSON.stringify(v);

describe("the request: balance as of one date", () => {
  it("one BalanceSheet GET for one day (start = end), the lane's method, no class filter", () => {
    expect(planBalanceSheetAt(DATE, "accrual")).toEqual({ path: "/v3/company/{realm}/reports/BalanceSheet", query: { start_date: DATE, end_date: DATE, accounting_method: "Accrual" }, date: DATE, method: "accrual" });
    expect(planBalanceSheetAt(DATE, "cash").query.accounting_method).toBe("Cash");
    expect(Object.keys(planBalanceSheetAt(DATE, "cash").query)).not.toContain("class");
  });
  it("refuses a date that is not a date", () => {
    expect(() => planBalanceSheetAt("tomorrow", "cash")).toThrow(ConnectorError);
  });
});

describe("the dates: the Friday of each completed business week (Saturday to Friday, America/New_York)", () => {
  const at = (iso: string) => Date.parse(iso);
  it("on a Friday the running week is not complete: the first date is the Friday before", () => {
    expect(cashHistoryDates(at("2026-11-27T17:00:00Z"), 4)).toEqual(["2026-11-20", "2026-11-13", "2026-11-06", "2026-10-30"]);
  });
  it("on a Saturday the week that ended yesterday is complete", () => {
    expect(cashHistoryDates(at("2026-11-28T17:00:00Z"), 4)).toEqual(["2026-11-27", "2026-11-20", "2026-11-13", "2026-11-06"]);
  });
  it("on a Sunday", () => {
    expect(cashHistoryDates(at("2026-11-29T17:00:00Z"), 2)).toEqual(["2026-11-27", "2026-11-20"]);
  });
  it("22:30 on a Friday in New York is already Saturday in UTC: the New York date wins", () => {
    expect(cashHistoryDates(at("2026-11-28T03:30:00Z"), 2)).toEqual(["2026-11-20", "2026-11-13"]);
    expect(cashHistoryDates(at("2026-11-28T05:30:00Z"), 2)).toEqual(["2026-11-27", "2026-11-20"]); // 00:30 Saturday New York
  });
  it("across a year end", () => {
    expect(cashHistoryDates(at("2027-01-02T07:30:00Z"), 4)).toEqual(["2027-01-01", "2026-12-25", "2026-12-18", "2026-12-11"]);
    expect(cashHistoryDates(at("2027-01-06T07:30:00Z"), 3)).toEqual(["2027-01-01", "2026-12-25", "2026-12-18"]);
    expect(cashHistoryDates(at("2026-12-31T20:00:00Z"), 2)).toEqual(["2026-12-25", "2026-12-18"]);
  });
  it("across a DST change (the night job at 02:00; both 01:30s of the fall-back night)", () => {
    expect(cashHistoryDates(at("2026-11-01T05:30:00Z"), 4)).toEqual(["2026-10-30", "2026-10-23", "2026-10-16", "2026-10-09"]);
    expect(cashHistoryDates(at("2026-11-01T06:30:00Z"), 4)).toEqual(["2026-10-30", "2026-10-23", "2026-10-16", "2026-10-09"]);
    expect(cashHistoryDates(at("2026-03-08T07:30:00Z"), 4)).toEqual(["2026-03-06", "2026-02-27", "2026-02-20", "2026-02-13"]);
  });
  it("one to thirteen weeks, newest first, seven days apart; anything else is refused", () => {
    const d = cashHistoryDates(at("2026-11-20T15:00:00Z"), 13);
    expect(d).toHaveLength(13);
    for (let i = 1; i < d.length; i += 1) expect((Date.parse(`${d[i - 1]}T00:00:00Z`) - Date.parse(`${d[i]}T00:00:00Z`)) / 86_400_000).toBe(7);
    for (const bad of [0, 14, 2.5, -1, Number.NaN]) expect(() => cashHistoryDates(at("2026-11-20T15:00:00Z"), bad)).toThrow(ConnectorError);
  });
});

describe("projection: ONLY {accountId, balance} of the asked accounts leaves, nothing else of the report", () => {
  const full = report([
    sec("Assets", undefined, [
      sec("Bank Accounts", undefined, [data("Operating Checking", "1", "84210.55"), data("Savings Reserve", "2", "-12.50"), data("Payroll Clearing Checking", "7", "31337.00")], "115535.05"),
      sec("Accounts Receivable", undefined, [data("Accounts Receivable (A/R)", "4", "18400.00")], "18400.00"),
    ], "133935.05"),
    sec("Liabilities and Equity", undefined, [
      sec("Equity", undefined, [data("Owner Equity", "9", "50000.00"), data("Retained Earnings", "10", "1.00"), data("Net Income", undefined, "55555.55")], "105556.55"),
    ], "105556.55"),
  ]);

  it("returns the asked accounts with the figure as a string, in id order", () => {
    const out = projectCashBookBalances(req, full, ids("2", "1"));
    expect(out.balances).toEqual([{ accountId: "1", balance: "84210.55" }, { accountId: "2", balance: "-12.50" }]);
    expect(out.producedAt).toBe("2026-11-27T10:00:00.000Z");
  });
  it("nothing else is in the output: no label, no total, no other account, no equity or net income figure", () => {
    const out = text(projectCashBookBalances(req, full, ids("1", "2")));
    for (const secret of ["Operating", "Savings", "Payroll", "Clearing", "Equity", "Net Income", "Retained", "Receivable", "Total", "31337", "115535", "133935", "105556", "55555", "50000", "18400", "BalanceSheet"]) {
      expect(out).not.toContain(secret);
    }
    expect(Object.keys(projectCashBookBalances(req, full, ids("1"))).sort()).toEqual(["balances", "producedAt"]);
    expect(Object.keys(projectCashBookBalances(req, full, ids("1")).balances[0]!).sort()).toEqual(["accountId", "balance"]);
  });
  it("a payroll account is never in the output unless its id was asked for (the caller removes payroll ids from the set)", () => {
    expect(projectCashBookBalances(req, full, ids("1", "2")).balances.map((b) => b.accountId)).not.toContain("7");
    expect(projectCashBookBalances(req, full, ids("7")).balances).toEqual([{ accountId: "7", balance: "31337.00" }]); // so the job MUST filter: tested below
  });
  it("equity, net income and totals are not bank accounts: a report with no asked id gives nothing", () => {
    expect(projectCashBookBalances(req, full, ids("99")).balances).toEqual([]);
    expect(projectCashBookBalances(req, full, ids()).balances).toEqual([]);
  });
  it("a row without an id is dropped, even when its label looks like the account", () => {
    const r = report([sec("Bank Accounts", undefined, [data("Operating Checking", undefined, "5.00"), data("Operating Checking", "", "6.00")], "11.00")]);
    expect(projectCashBookBalances(req, r, ids("1")).balances).toEqual([]);
  });
  it("a label is never matched: an account named like an id does not match", () => {
    const r = report([data("1", undefined, "5.00"), data("Account 1", "x1", "6.00")]);
    expect(projectCashBookBalances(req, r, ids("1")).balances).toEqual([]);
  });
  it("a sub-account's own row is kept; its parent (header and total carry the parent's id) is left out, never guessed", () => {
    const r = report([
      sec("Bank Accounts", undefined, [
        sec("Reserve", "2", [data("Reserve Sub", "3", "10000.00")], "10000.00", "2"),
        data("Operating Checking", "1", "84210.55"),
      ], "94210.55"),
    ]);
    expect(projectCashBookBalances(req, r, ids("1", "2", "3")).balances).toEqual([{ accountId: "1", balance: "84210.55" }, { accountId: "3", balance: "10000.00" }]);
  });
  it("a parent with its own row AND a section header/total carrying its id is ambiguous: nothing is stored for it", () => {
    const r = report([sec("Reserve", "2", [data("Reserve", "2", "300.00"), data("Reserve Sub", "3", "700.00")], "1000.00", "2")]);
    expect(projectCashBookBalances(req, r, ids("2", "3")).balances).toEqual([{ accountId: "3", balance: "700.00" }]);
  });
  it("an account listed on two data rows is ambiguous: nothing is stored for it, the others are kept", () => {
    const r = report([data("A", "1", "1.00"), data("A again", "1", "2.00"), data("B", "2", "3.00")]);
    expect(projectCashBookBalances(req, r, ids("1", "2")).balances).toEqual([{ accountId: "2", balance: "3.00" }]);
  });
  it("an id on a section total only (no own row) gives nothing", () => {
    const r = report([sec("Bank Accounts", undefined, [data("X", "9", "1.00")], "500.00", "1")]);
    expect(projectCashBookBalances(req, r, ids("1")).balances).toEqual([]);
  });
  it("a row that is not exactly an account cell and one figure cell, or whose figure is not a figure, is dropped", () => {
    const r = report([
      { type: "Data", ColData: [cd("A", "1"), cd("1.00"), cd("2.00")] },
      { type: "Data", ColData: [cd("B", "2")] },
      data("C", "3", "abc"),
      data("D", "4", ""),
      data("E", "5", "1,000.00"),
      data("F", "6", "12.5"),
      { type: "Section", ColData: [cd("G", "7"), cd("9.00")] },
      { ColData: [cd("H", "8"), cd("9.00")] },
    ]);
    expect(projectCashBookBalances(req, r, ids("1", "2", "3", "4", "5", "6", "7", "8")).balances).toEqual([{ accountId: "6", balance: "12.5" }]);
  });
  it("a report with no rows gives nothing", () => {
    expect(projectCashBookBalances(req, report([]), ids("1")).balances).toEqual([]);
    expect(projectCashBookBalances(req, { Header: {} }, ids("1")).balances).toEqual([]);
  });
});

describe("projection: refusals (fail closed) carry nothing of the report", () => {
  const SECRET = "Payroll Secret Label 9999999";
  const message = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectorError);
      return text((e as ConnectorError).info) + String(e);
    }
    throw new Error("expected a refusal");
  };
  it("an oversized report is refused (rows), without its content", () => {
    const rows = Array.from({ length: 20_001 }, (_v, i) => data(SECRET, String(i + 100), "1.00"));
    const m = message(() => projectCashBookBalances(req, report([sec("Assets", undefined, rows, "1.00")]), ids("1")));
    expect(m).not.toContain("Payroll");
    expect(m).not.toContain("9999999");
  });
  it("a report nested deeper than the limit is refused", () => {
    let node: unknown = data(SECRET, "1", "1.00");
    for (let i = 0; i < 12; i += 1) node = sec(SECRET, undefined, [node], "1.00");
    expect(message(() => projectCashBookBalances(req, report([node]), ids("1")))).not.toContain("Payroll");
  });
  it("a row of the wrong shape is refused without echoing it", () => {
    const m = message(() => projectCashBookBalances(req, report([{ type: "Data", ColData: [{ value: 12345, id: SECRET }] }]), ids("1")));
    expect(m).not.toContain("Payroll");
    expect(message(() => projectCashBookBalances(req, report(["Payroll Secret"]), ids("1")))).not.toContain("Secret");
    expect(message(() => projectCashBookBalances(req, "Payroll Secret", ids("1")))).not.toContain("Secret");
  });
  it("a report for another date, another basis or another currency is refused (figures would be mislabelled)", () => {
    expect(message(() => projectCashBookBalances(req, report([], { EndPeriod: "2026-11-27" }), ids("1")))).toContain("requested date");
    expect(message(() => projectCashBookBalances(req, report([], { ReportBasis: "Cash" }), ids("1")))).toContain("basis");
    expect(message(() => projectCashBookBalances(req, report([], { Currency: "EUR" }), ids("1")))).toContain("currency");
    expect(projectCashBookBalances(planBalanceSheetAt(DATE, "cash"), report([], { ReportBasis: "Cash" }), ids("1")).balances).toEqual([]);
  });
  it("more than 200 ids asked for is refused", () => {
    expect(() => projectCashBookBalances(req, report([]), new Set(Array.from({ length: 201 }, (_v, i) => String(i))))).toThrow(ConnectorError);
  });
  it("an implausible production time is not trusted (null)", () => {
    expect(projectCashBookBalances(req, report([], { Time: "yesterday" }), ids("1")).producedAt).toBeNull();
  });
});

// ---------------------------------------------------------------- the job
type Setup = { h: QboHarness; conn: QboConnection; intuit: ReturnType<typeof createFakeIntuit> };
async function setup(): Promise<Setup> {
  const d = syntheticData(1);
  d.Account = syntheticReportAccounts();
  const intuit = createFakeIntuit({ data: d });
  server.use(...intuit.handlers);
  const h = createQboHarness({ intuit });
  const conn = await h.connectViaCallback(LANE);
  intuit.state.apiRequests.length = 0;
  h.reportState.settings = { ...h.reportState.settings, kinds: ["pnl"], weeks: 3, cashHistory: true };
  h.cashState.ids = ["1"];
  return { h, conn, intuit };
}
const sheets = (s: Setup) => s.intuit.state.reportRequests.filter((r) => r.name === "BalanceSheet");

describe("the nightly job: one Balance Sheet read per completed week, bank rows only, nothing of the report cached", () => {
  it("reads the Friday of each of the last N completed weeks and writes each date once", async () => {
    const s = await setup();
    const out = await s.h.reportsJob.run(LANE, s.conn.id);
    expect(out).toMatchObject({ ok: true });
    const want = cashHistoryDates(s.h.clock.t, 3);
    expect(sheets(s).map((r) => r.query.end_date)).toEqual(want);
    for (const r of sheets(s)) expect(r.query).toMatchObject({ start_date: r.query.end_date, end_date: r.query.end_date, accounting_method: "Accrual" });
    expect(s.h.cashState.puts.map((p) => p.date)).toEqual(want);
    for (const p of s.h.cashState.puts) expect(p.balances).toEqual([{ accountId: "1", balance: "84210.55" }]);
    expect(s.intuit.state.unexpected).toEqual([]);
  });
  it("D-27: the Balance Sheet is not cached and balance_sheet is not a report kind that is fetched for the cache", async () => {
    const s = await setup();
    await s.h.reportsJob.run(LANE, s.conn.id);
    expect(s.h.reportState.stored.map((e) => e.report)).not.toContain("balance_sheet");
    expect(JSON.stringify(s.h.reportState.stored)).not.toContain("84210.55");
  });
  it("the number of weeks comes from the settings (N requests, no more)", async () => {
    const s = await setup();
    s.h.reportState.settings = { ...s.h.reportState.settings, weeks: 13 };
    await s.h.reportsJob.run(LANE, s.conn.id);
    expect(sheets(s)).toHaveLength(13);
  });
  it("the switch off: no Balance Sheet request and nothing written", async () => {
    const s = await setup();
    s.h.reportState.settings = { ...s.h.reportState.settings, cashHistory: false };
    expect(await s.h.reportsJob.run(LANE, s.conn.id)).toMatchObject({ ok: true });
    expect(sheets(s)).toHaveLength(0);
    expect(s.h.cashState.puts).toEqual([]);
    expect(s.h.reportState.stored.length).toBeGreaterThan(0);
  });
  it("no bank accounts kept by the normalizer: nothing is requested", async () => {
    const s = await setup();
    s.h.cashState.ids = [];
    await s.h.reportsJob.run(LANE, s.conn.id);
    expect(sheets(s)).toHaveLength(0);
  });
  it("a payroll account is never written, even if it were listed as a bank account", async () => {
    const s = await setup();
    s.h.cashState.ids = ["1", "60"]; // 60 is a payroll account in the fixtures (PayrollExpenses)
    s.intuit.state.balanceSheetByDate = {};
    const d = cashHistoryDates(s.h.clock.t, 3);
    for (const date of d) s.intuit.state.balanceSheetByDate[date] = report([sec("Bank Accounts", undefined, [data("Operating Checking", "1", "10.00"), data("Team Costs Checking", "60", "777.00")], "787.00")], { EndPeriod: date, StartPeriod: date, Time: new Date(s.h.clock.t - 60_000).toISOString() });
    expect(await s.h.reportsJob.run(LANE, s.conn.id)).toMatchObject({ ok: true });
    for (const p of s.h.cashState.puts) expect(p.balances).toEqual([{ accountId: "1", balance: "10.00" }]);
    expect(JSON.stringify(s.h.cashState.puts)).not.toContain("777");
  });
  it("an account the report does not show for a date is left out of that date's call (the database then removes the old figure)", async () => {
    const s = await setup();
    s.h.cashState.ids = ["1", "2"];
    await s.h.reportsJob.run(LANE, s.conn.id);
    for (const p of s.h.cashState.puts) expect(p.balances.map((b) => b.accountId)).toEqual(["1"]);
  });
  it("as_of is Intuit's production time when plausible, otherwise our fetch time", async () => {
    const s = await setup();
    await s.h.reportsJob.run(LANE, s.conn.id);
    for (const p of s.h.cashState.puts) {
      expect(Date.parse(p.asOf)).toBeLessThanOrEqual(s.h.clock.t);
      expect(Date.parse(p.asOf)).toBeGreaterThan(s.h.clock.t - 3_600_000);
    }
  });
  it("a PERMANENT failure (a malformed report for one date) does not fail the run: the other dates are written, the reports stored, and it is logged with constant text", async () => {
    const s = await setup();
    const d = cashHistoryDates(s.h.clock.t, 3);
    s.intuit.state.balanceSheetByDate[d[1]!] = { Header: {}, Rows: { Row: ["bad"] } };
    const out = await s.h.reportsJob.run(LANE, s.conn.id);
    expect(out).toMatchObject({ ok: true, skipped: null });
    expect(s.h.cashState.puts.map((p) => p.date)).toEqual([d[0], d[2]]);
    expect(s.h.reportState.stored.length).toBeGreaterThan(0);
    const warned = s.h.logs.filter((l) => l.event === "qbo.cash_history.not_stored");
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned[0])).toContain(d[1]!);
    expect(JSON.stringify(warned[0])).not.toContain("bad");
  });
  it("a PERMANENT database refusal of one date or of the account list does not fail the run either", async () => {
    const s = await setup();
    const d = cashHistoryDates(s.h.clock.t, 3);
    s.h.cashState.permanentDates = [d[0]!];
    expect(await s.h.reportsJob.run(LANE, s.conn.id)).toMatchObject({ ok: true });
    expect(s.h.cashState.puts.map((p) => p.date)).toEqual([d[1], d[2]]);
    s.h.cashState.permanentIds = true;
    expect(await s.h.reportsJob.run(LANE, s.conn.id)).toMatchObject({ ok: true });
  });
  it("a TRANSIENT failure (the store is unavailable for one date) fails the run so it is retried; the other dates are written", async () => {
    const s = await setup();
    const d = cashHistoryDates(s.h.clock.t, 3);
    s.h.cashState.failDates = [d[2]!];
    const out = await s.h.reportsJob.run(LANE, s.conn.id);
    expect(out).toMatchObject({ ok: false, retryable: true });
    expect(s.h.cashState.puts.map((p) => p.date)).toEqual([d[0], d[1]]);
  });
  it("a store failure on one date is retryable; the other dates are written", async () => {
    const s = await setup();
    const d = cashHistoryDates(s.h.clock.t, 3);
    s.h.cashState.failDates = [d[0]!];
    const out = await s.h.reportsJob.run(LANE, s.conn.id);
    expect(out).toMatchObject({ ok: false, retryable: true });
    expect(s.h.cashState.puts.map((p) => p.date)).toEqual([d[1], d[2]]);
  });
  it("the purge runs first on its own with the switch on (retention only); with the switch off it removes the connection's rows and nothing is read", async () => {
    const s = await setup();
    await s.h.reportsJob.run(LANE, s.conn.id);
    expect(s.h.cashState.purges).toEqual([false]);
    expect(s.h.cashState.puts).toHaveLength(3);
    s.h.reportState.settings = { ...s.h.reportState.settings, cashHistory: false };
    s.intuit.state.reportRequests.length = 0;
    await s.h.reportsJob.run(LANE, s.conn.id);
    expect(s.h.cashState.purges).toEqual([false, true]);
    expect(s.h.cashState.puts).toEqual([]);
    expect(sheets(s)).toHaveLength(0);
  });
  it("retention does not depend on a write: it runs even when every write fails, and a purge outage is retried without stopping the reports", async () => {
    const s = await setup();
    s.h.cashState.failDates = cashHistoryDates(s.h.clock.t, 3);
    await s.h.reportsJob.run(LANE, s.conn.id);
    expect(s.h.cashState.purges).toEqual([false]);
    s.h.cashState.failPurge = true;
    s.h.reportState.stored.length = 0;
    const out = await s.h.reportsJob.run(LANE, s.conn.id);
    expect(out).toMatchObject({ ok: false, retryable: true });
    expect(s.h.reportState.stored.length).toBeGreaterThan(0);
  });
  it("the report fetches happen first: a failing account list does not stop them", async () => {
    const s = await setup();
    s.h.cashState.failIds = true;
    const out = await s.h.reportsJob.run(LANE, s.conn.id);
    expect(out).toMatchObject({ ok: false, retryable: true });
    expect(s.h.reportState.stored.map((e) => e.report)).toContain("pnl");
    expect(sheets(s)).toHaveLength(0);
  });
  it("re-reads every night: a changed past balance is written again", async () => {
    const s = await setup();
    await s.h.reportsJob.run(LANE, s.conn.id);
    const d = cashHistoryDates(s.h.clock.t, 3);
    s.intuit.state.balanceSheetByDate[d[0]!] = report([data("Operating Checking", "1", "99.99")], { EndPeriod: d[0], StartPeriod: d[0], Time: new Date(s.h.clock.t - 1000).toISOString() });
    await s.h.reportsJob.run(LANE, s.conn.id);
    expect(s.h.cashState.puts.find((p) => p.date === d[0])!.balances).toEqual([{ accountId: "1", balance: "99.99" }]);
    expect(s.h.cashState.puts).toHaveLength(3);
  });
  it("the class filter is never sent for balances, even with class tracking and classes configured", async () => {
    const s = await setup();
    (s.h.rows.get(s.conn.id) as { features: Record<string, boolean> }).features = { class_tracking: true };
    s.h.reportState.settings = { ...s.h.reportState.settings, classIds: ["2"] };
    await s.h.reportsJob.run(LANE, s.conn.id);
    for (const r of sheets(s)) expect(Object.keys(r.query)).not.toContain("class");
  });
  it("logs counts and dates only: no account id, label or figure of the Balance Sheet", async () => {
    const s = await setup();
    s.h.cashState.failDates = [cashHistoryDates(s.h.clock.t, 3)[0]!];
    await s.h.reportsJob.run(LANE, s.conn.id);
    const logged = JSON.stringify(s.h.logs);
    for (const secret of ["Operating Checking", "84210.55", "Reserve", "Accounts Receivable", "Total Assets"]) expect(logged).not.toContain(secret);
    expect(logged).toContain("qbo.cash_history.failed");
  });
  it("a connection that is not usable is skipped before any request", async () => {
    const s = await setup();
    (s.h.rows.get(s.conn.id) as { status: string }).status = "reconnect_required";
    expect(await s.h.reportsJob.run(LANE, s.conn.id)).toMatchObject({ ok: true, skipped: "connection_not_usable" });
    expect(sheets(s)).toHaveLength(0);
  });
});
