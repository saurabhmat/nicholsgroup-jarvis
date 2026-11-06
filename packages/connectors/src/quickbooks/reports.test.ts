/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index into synthetic data they just built */
// T-052 QuickBooks Reports API (QB-10 reports): over the fake Intuit (MSW) with synthetic report fixtures and the
// in-memory harness twins (lane_config, fin.report_cache with the database guard's rules ported). Each describe block
// names the acceptance clause it proves. SQL behaviour of the real guard is in supabase/core/supabase/tests/210_*.
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { useMockServer } from "../testing/msw/index";
import { createFakeIntuit, type FakeIntuit } from "../testing/msw/quickbooks/handlers";
import { REPORT_PAYROLL_ACCOUNT_IDS, syntheticData, syntheticReportAccounts, syntheticReports, type FakeObject } from "../testing/msw/quickbooks/fixtures";
import { createQboHarness, type QboHarness } from "../testing/quickbooks-harness";
import type { QboConnection } from "./guard";
import { businessDate, maskLabel, planReports, projectReport, QBO_REPORT_KINDS, REPORT_DEFS, reportPolicy, type ReportPolicy, type ReportRequest, type ReportSettings } from "./reports";

const server = useMockServer();
const LANE = "PKG";
const ALL = ["pnl", "balance_sheet", "cash_flow", "ar_aging_summary", "ap_aging_summary"] as const;
afterEach(() => RateLimiter.resetForTests());

const jsonDepth = (v: unknown): number => (v !== null && typeof v === "object" ? 1 + Math.max(0, ...Object.values(v).map(jsonDepth)) : 0);
const text = (v: unknown) => JSON.stringify(v);

type Setup = { intuit: FakeIntuit; h: QboHarness; conn: QboConnection };
async function setup(opts: { classTracking?: boolean; accounts?: FakeObject[] } = {}): Promise<Setup> {
  const data = syntheticData(1);
  data.Account = opts.accounts ?? syntheticReportAccounts();
  const intuit = createFakeIntuit({ data });
  server.use(...intuit.handlers);
  const h = createQboHarness({ intuit });
  const conn = await h.connectViaCallback(LANE);
  if (opts.classTracking) (h.rows.get(conn.id) as { features: Record<string, boolean> }).features = { class_tracking: true };
  intuit.state.apiRequests.length = 0;
  return { intuit, h, conn };
}
const entry = (h: QboHarness, kind: string) => h.reportState.stored.find((e) => e.report === kind)!;

describe("what is asked for: date range, accounting method and class come from lane_config (acceptance)", () => {
  const base: ReportSettings = { method: "accrual", period: "year_to_date", classIds: [], kinds: ALL };
  const NOW = Date.parse("2026-11-06T15:00:00Z");
  const by = (reqs: ReportRequest[], kind: string) => reqs.find((r) => r.kind === kind)!;

  it("plans only the listed kinds (the default list leaves out balance_sheet and cash_flow, D-27)", () => {
    expect(planReports({ ...base, kinds: ["pnl", "ar_aging_summary", "ap_aging_summary"] }, false, NOW).map((r) => r.kind)).toEqual(["pnl", "ar_aging_summary", "ap_aging_summary"]);
    expect(planReports({ ...base, kinds: [] }, false, NOW)).toEqual([]);
  });

  it("plans exactly the five summary reports, GET paths under /reports, with the cache report names", () => {
    const reqs = planReports(base, false, NOW);
    expect(reqs.map((r) => r.kind)).toEqual([...QBO_REPORT_KINDS]);
    expect(reqs.map((r) => r.path.split("/").pop())).toEqual(["ProfitAndLoss", "BalanceSheet", "CashFlow", "AgedReceivables", "AgedPayables"]);
    expect(QBO_REPORT_KINDS).toEqual(["pnl", "balance_sheet", "cash_flow", "ar_aging_summary", "ap_aging_summary"]);
  });

  it("year to date and trailing 12 months, in America/New_York (a late evening Dec 31 is still Dec 31)", () => {
    expect(by(planReports(base, false, NOW), "pnl").query).toMatchObject({ start_date: "2026-01-01", end_date: "2026-11-06" });
    const lateEve = Date.parse("2027-01-01T03:30:00Z"); // 22:30 Dec 31 in New York
    expect(businessDate(lateEve).iso).toBe("2026-12-31");
    expect(by(planReports(base, false, lateEve), "pnl").query).toMatchObject({ start_date: "2026-01-01", end_date: "2026-12-31" });
    const t12 = { ...base, period: "trailing_12_months" as const };
    expect(by(planReports(t12, false, NOW), "pnl").query).toMatchObject({ start_date: "2025-12-01", end_date: "2026-11-06" });
    expect(by(planReports(t12, false, Date.parse("2026-03-15T15:00:00Z")), "cash_flow").query).toMatchObject({ start_date: "2025-04-01", end_date: "2026-03-15" });
    expect(by(planReports(t12, false, Date.parse("2026-12-15T15:00:00Z")), "pnl").query.start_date).toBe("2026-01-01");
  });

  it("the accounting method is sent (and in params) where the report takes one", () => {
    const cash = planReports({ ...base, method: "cash" }, false, NOW);
    expect(by(cash, "pnl").query.accounting_method).toBe("Cash");
    expect(by(cash, "pnl").params.method).toBe("cash");
    expect(by(cash, "balance_sheet").params.method).toBe("cash");
    for (const k of ["cash_flow", "ar_aging_summary", "ap_aging_summary"]) {
      expect(by(cash, k).query.accounting_method).toBeUndefined();
      expect(by(cash, k).params.method).toBeUndefined();
    }
  });

  it("aging summaries are as of a report date; the others take a range", () => {
    const reqs = planReports(base, false, NOW);
    expect(by(reqs, "ar_aging_summary").query).toEqual({ report_date: "2026-11-06" });
    expect(by(reqs, "ap_aging_summary").params).toEqual({ report_date: "2026-11-06" });
    expect(by(reqs, "balance_sheet").query.end_date).toBe("2026-11-06");
  });

  it("the class filter is used only with class tracking on, and only by reports that take it; otherwise unsplit and marked", () => {
    const withClasses: ReportSettings = { ...base, classIds: ["12", "3", "12"] };
    const on = planReports(withClasses, true, NOW);
    expect(by(on, "pnl").query.class).toBe("12,3".split(",").sort().join(","));
    expect(by(on, "pnl").params.class).toBe("12,3".split(",").sort().join(","));
    expect(by(on, "balance_sheet").params.class).toBe(by(on, "pnl").params.class);
    for (const k of ["cash_flow", "ar_aging_summary", "ap_aging_summary"]) {
      expect(REPORT_DEFS[k as keyof typeof REPORT_DEFS].classFilter).toBe(false);
      expect(by(on, k).query.class).toBeUndefined();
      expect(by(on, k).params).not.toHaveProperty("class");
      expect(by(on, k).params.unsplit).toBe("report_not_class_aware");
    }
    const off = planReports(withClasses, false, NOW);
    for (const r of off) {
      expect(r.query.class).toBeUndefined();
      expect(r.params).not.toHaveProperty("class");
      expect(r.params.unsplit).toBe("class_tracking_off");
    }
    // no class configured: unsplit by definition, no marker needed
    expect(planReports(base, true, NOW).every((r) => !("class" in r.params) && !("unsplit" in r.params))).toBe(true);
    // a class id that is not digits is never sent
    expect(by(planReports({ ...base, classIds: ["1; drop", "7"] }, true, NOW), "pnl").query.class).toBe("7");
  });
});

describe("a pull: five reports into the cache, GET only (acceptance: stored with params and as_of)", () => {
  it("fetches and stores all five with params, as_of and fetched_at", async () => {
    const { intuit, h, conn } = await setup();
    const out = await h.reportsJob.run(LANE, conn.id);
    expect(out).toMatchObject({ ok: true, skipped: null });
    expect(h.reportState.stored.map((e) => e.report)).toEqual([...QBO_REPORT_KINDS]);
    expect(intuit.state.reportRequests.map((r) => r.name)).toEqual(["ProfitAndLoss", "BalanceSheet", "CashFlow", "AgedReceivables", "AgedPayables"]);
    const today = businessDate(h.clock.t).iso;
    expect(entry(h, "pnl").params).toMatchObject({ method: "accrual", end_date: today });
    expect(intuit.state.reportRequests[0]?.query).toMatchObject({ accounting_method: "Accrual", end_date: today });
    for (const e of h.reportState.stored) {
      expect(Date.parse(e.asOf)).toBeLessThanOrEqual(Date.parse(e.fetchedAt));
      expect(e.fetchedAt).toBe(new Date(h.clock.t).toISOString());
    }
    // the as_of is Intuit's own production time (the fixture says ten minutes ago)
    expect(Date.parse(entry(h, "pnl").asOf)).toBeLessThan(h.clock.t - 500_000);
    // read only: every call was a GET and nothing else was requested
    expect(intuit.state.unexpected).toEqual([]);
    expect(intuit.state.apiRequests.every((r) => r.method === "GET")).toBe(true);
  });

  it("the same report time replaces its row; a newer report time adds a row (history), never changes an old one", async () => {
    const { intuit, h, conn } = await setup();
    await h.reportsJob.run(LANE, conn.id);
    await h.reportsJob.run(LANE, conn.id);
    expect(h.reportState.stored).toHaveLength(5);
    const first = h.reportState.stored.map((e) => e.asOf);
    intuit.state.reports = syntheticReports(new Date(h.clock.t - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"));
    await h.reportsJob.run(LANE, conn.id);
    expect(h.reportState.stored).toHaveLength(10);
    expect(h.reportState.stored.slice(0, 5).map((e) => e.asOf)).toEqual(first);
  });

  it("an id that is not digits is dropped (it could trip the database value guard); the row stays", async () => {
    const { intuit, h, conn } = await setup();
    const rows = (intuit.state.reports.ProfitAndLoss as { Rows: { Row: { Rows: { Row: { ColData: { id?: string }[] }[] } }[] } }).Rows.Row;
    rows[0]!.Rows.Row[0]!.ColData[0]!.id = "AB123456";
    await h.reportsJob.run(LANE, conn.id);
    const income = entry(h, "pnl").payload.Rows.Row.find((r) => r.ColData[0]?.value === "Subscription Income");
    expect(income).toBeDefined();
    expect(income?.ColData[0]).toEqual({ value: "Subscription Income" });
    expect(h.reportGuardProblem(entry(h, "pnl").payload)).toBeNull();
  });

  it("an implausible report time (ahead of our clock, or over an hour old) becomes the fetch time", async () => {
    for (const offset of [86_400_000, -2 * 3_600_000]) {
      const { intuit, h, conn } = await setup();
      intuit.state.reports = syntheticReports(new Date(h.clock.t + offset).toISOString().replace(/\.\d{3}Z$/, "Z"));
      await h.reportsJob.run(LANE, conn.id);
      for (const e of h.reportState.stored) expect(e.asOf, String(offset)).toBe(e.fetchedAt);
    }
  });

  it("the class filter reaches Intuit only when the connection's class-tracking flag is on (P&L and balance sheet)", async () => {
    const on = await setup({ classTracking: true });
    on.h.reportState.settings = { method: "accrual", period: "year_to_date", classIds: ["2", "5"], kinds: ALL };
    await on.h.reportsJob.run(LANE, on.conn.id);
    const asked = Object.fromEntries(on.intuit.state.reportRequests.map((r) => [r.name, r.query.class]));
    expect(asked).toEqual({ ProfitAndLoss: "2,5", BalanceSheet: "2,5", CashFlow: undefined, AgedReceivables: undefined, AgedPayables: undefined });
    expect(entry(on.h, "pnl").params.class).toBe("2,5");
    expect(entry(on.h, "ar_aging_summary").params).toMatchObject({ unsplit: "report_not_class_aware" });

    const off = await setup({ classTracking: false });
    off.h.reportState.settings = { method: "cash", period: "trailing_12_months", classIds: ["2"], kinds: ALL };
    for (const name of ["ProfitAndLoss", "BalanceSheet"]) (off.intuit.state.reports[name] as { Header: Record<string, unknown> }).Header.ReportBasis = "Cash";
    await off.h.reportsJob.run(LANE, off.conn.id);
    expect(off.intuit.state.reportRequests.every((r) => r.query.class === undefined)).toBe(true);
    for (const e of off.h.reportState.stored) expect(e.params).toMatchObject({ unsplit: "class_tracking_off" });
    expect(entry(off.h, "pnl").params).not.toHaveProperty("class");
    expect(entry(off.h, "pnl").params.method).toBe("cash");
  });
});

describe("kinds (D-27): fail closed", () => {
  it("only listed kinds are fetched and cached; an empty list fetches nothing", async () => {
    const { intuit, h, conn } = await setup();
    h.reportState.settings = { ...h.reportState.settings, kinds: ["pnl", "ar_aging_summary", "ap_aging_summary"] };
    expect(await h.reportsJob.run(LANE, conn.id)).toMatchObject({ ok: true, stored: ["pnl", "ar_aging_summary", "ap_aging_summary"] });
    expect(intuit.state.reportRequests.map((r) => r.name)).toEqual(["ProfitAndLoss", "AgedReceivables", "AgedPayables"]);
    expect(h.reportState.stored.map((e) => e.report)).not.toContain("balance_sheet");
    const none = await setup();
    none.h.reportState.settings = { ...none.h.reportState.settings, kinds: [] };
    expect(await none.h.reportsJob.run(LANE, none.conn.id)).toMatchObject({ ok: true, stored: [] });
    expect(none.intuit.state.reportRequests).toEqual([]);
  });

  it("P&L plus aging alone: with payroll removed no total, Net Income or Gross Profit remains to subtract from, and nothing else cached repeats it", async () => {
    const { intuit, h, conn } = await setup();
    h.reportState.settings = { ...h.reportState.settings, kinds: ["pnl", "ar_aging_summary", "ap_aging_summary"] };
    const pnl = intuit.state.reports.ProfitAndLoss as { Rows: { Row: unknown[] } };
    pnl.Rows.Row.push({ type: "Section", group: "GrossProfit", Summary: { ColData: [{ value: "Gross Profit" }, { value: "150000.00" }] } });
    await h.reportsJob.run(LANE, conn.id);
    const t = text(h.reportState.stored.filter((e) => e.report === "pnl").map((e) => e.payload));
    for (const gone of ["Total Expenses", "Net Income", "Gross Profit", "111288.50", "150000.00", "40712.00"]) expect(t, gone).not.toContain(gone);
    // the kept rows alone never add up to a withheld figure: Total Income is the only P&L total and has no removed row below it
    expect(entry(h, "pnl").payload.Rows.Row.filter((r) => r.type === "Summary").map((r) => r.ColData[0]?.value)).toEqual(["Total Income"]);
    expect(entry(h, "pnl").payload.Header.TotalsWithheld).toBe("true");
    expect(entry(h, "ap_aging_summary").payload.Header.TotalsWithheld).toBe("false");
  });

  it("while people are on excluded_entity_ids only the aging summaries are cached (their pay would show in ordinary P&L lines)", async () => {
    const { intuit, h, conn } = await setup();
    h.payrollState.settings = { ...h.payrollState.settings, excludedEntityIds: ["2"] };
    const out = await h.reportsJob.run(LANE, conn.id);
    expect(out).toMatchObject({ ok: true, stored: ["ar_aging_summary", "ap_aging_summary"] });
    expect(intuit.state.reportRequests.map((r) => r.name)).toEqual(["AgedReceivables", "AgedPayables"]);
    expect(text(h.logs)).toContain("qbo.reports.kinds_withheld");
  });
});

describe("default settings from an empty lane_config", () => {
  it("send only the three default requests", async () => {
    const { createLaneConfigReader } = await import("../vault/lane-config");
    const reader = createLaneConfigReader(async () => ({ schema: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config: {} }, error: null }) }) }) }) }) }) as never);
    const { intuit, h, conn } = await setup();
    h.reportState.settings = await reader.reportSettings(LANE);
    await h.reportsJob.run(LANE, conn.id);
    expect(intuit.state.reportRequests.map((r) => r.name)).toEqual(["ProfitAndLoss", "AgedReceivables", "AgedPayables"]);
  });
});

describe("the stored projection: strict allowlist, flat, Id kept (acceptance)", () => {
  it("top level is Header, Columns, Rows only; unknown keys at every level are dropped", async () => {
    const { intuit, h, conn } = await setup();
    const pnl = intuit.state.reports.ProfitAndLoss as Record<string, unknown>;
    pnl.Memo = "top level memo";
    pnl.Rows = { ...(pnl.Rows as object), Extra: "x" };
    await h.reportsJob.run(LANE, conn.id);
    for (const e of h.reportState.stored) {
      expect(Object.keys(e.payload).sort()).toEqual(["Columns", "Header", "Rows"]);
      expect(Object.keys(e.payload.Rows)).toEqual(["Row"]);
      expect(Object.keys(e.payload.Columns)).toEqual(["Column"]);
      expect(h.reportGuardProblem(e.payload)).toBeNull();
    }
    const t = text(entry(h, "pnl").payload);
    for (const gone of ["Memo", "memo", "href", "Option", "MetaData", "ColKey", "Extra", "AccountingStandard"]) expect(t).not.toContain(gone);
  });

  it("Header keeps scalar fields only; columns keep title and type", async () => {
    const { h, conn } = await setup();
    await h.reportsJob.run(LANE, conn.id);
    const p = entry(h, "pnl").payload;
    expect(Object.keys(p.Header).sort()).toEqual(["Currency", "TotalsWithheld", "ReportBasis", "ReportName", "StartPeriod", "EndPeriod", "SummarizeColumnsBy", "Time"].sort());
    expect(p.Header).toMatchObject({ ReportName: "ProfitAndLoss", ReportBasis: "Accrual", Currency: "USD" });
    expect(p.Columns.Column).toEqual([{ ColTitle: "", ColType: "Account" }, { ColTitle: "Total", ColType: "Money" }]);
    expect(entry(h, "cash_flow").payload.Header).not.toHaveProperty("ReportBasis");
  });

  it("keeps the account Id on every account row (the cash view matches fin.accounts.source_id)", async () => {
    const { h, conn } = await setup();
    await h.reportsJob.run(LANE, conn.id);
    const bs = entry(h, "balance_sheet").payload.Rows.Row;
    const ids = new Map(bs.filter((r) => r.type === "Data").map((r) => [r.ColData[0]?.value, r.ColData[0]?.id]));
    expect(ids.get("Operating Checking")).toBe("1");
    expect(ids.get("Reserve Sub-account")).toBe("3");
    expect(ids.get("Accounts Payable (A/P)")).toBe("5");
    // figures stay the strings Intuit sent (rule 7: SQL does the arithmetic)
    expect(bs.find((r) => r.ColData[0]?.id === "1")?.ColData[1]?.value).toBe("84210.55");
  });

  it("flattens the BalanceSheet: the raw answer is over the database's 16-level scan, the stored rows are about 5", async () => {
    const { intuit, h, conn } = await setup();
    expect(jsonDepth(intuit.state.reports.BalanceSheet)).toBeGreaterThanOrEqual(16);
    await h.reportsJob.run(LANE, conn.id);
    const p = entry(h, "balance_sheet").payload;
    expect(jsonDepth(p)).toBeLessThanOrEqual(7);
    // document order, level kept: the tree can be rebuilt
    const rows = p.Rows.Row;
    expect(rows.map((r) => `${r.type}:${String(r.level)}:${r.ColData[0]?.value}`).slice(0, 8)).toEqual([
      "Header:0:ASSETS", "Header:1:Current Assets", "Header:2:Bank Accounts", "Data:3:Operating Checking", "Header:3:Reserve Account", "Data:4:Reserve Sub-account", "Summary:3:Total Reserve Account", "Summary:2:Total Bank Accounts",
    ]);
    expect(rows.find((r) => r.ColData[0]?.value === "Total ASSETS")?.type).toBe("Summary");
    expect(h.reportGuardProblem(p)).toBeNull();
  });

  it("refuses (does not truncate) a report nested deeper than the connector allows", () => {
    const deep: unknown = Array.from({ length: 1 }, () => null).reduce<unknown>((acc) => acc, { type: "Data", ColData: [{ value: "x" }] });
    let node: unknown = deep;
    for (let i = 0; i < 12; i += 1) node = { type: "Section", Header: { ColData: [{ value: "s" }] }, Rows: { Row: [node] } };
    const req = planReports({ method: "accrual", period: "year_to_date", classIds: [], kinds: ["pnl"] }, false, Date.now())[0]!;
    expect(() => projectReport(req, { Header: {}, Rows: { Row: [node] } }, { payrollAccountIds: new Set(), excludedEntityIds: new Set() })).toThrow(/nested too deeply/);
  });

  it("masks account numbers in label text (database rule: a letter and 5+ digits) and keeps real figures", async () => {
    const { h, conn } = await setup();
    await h.reportsJob.run(LANE, conn.id);
    const t = text(entry(h, "pnl").payload);
    expect(t).not.toContain("123456789");
    expect(t).toContain("Operating Checking [masked] fees");
    expect(t).toContain("152000.50");
    for (const e of h.reportState.stored) expect(h.reportGuardProblem(e.payload)).toBeNull();
    // unit: separators, full-width digits, short runs, figures with no letters
    expect(maskLabel("Savings 1234-5678")).toBe("Savings [masked]");
    expect(maskLabel("Checking １２３４５６")).toBe("Checking [masked]");
    expect(maskLabel("Acct 1234")).toBe("Acct 1234");
    expect(maskLabel("1234567.89")).toBe("1234567.89");
    expect(maskLabel("é12345")).toBe("é[masked]");
  });

  it("aging summaries drop every customer / vendor name (rows, parent sections, \"Total <name>\"), keep the Id and the TOTAL row", async () => {
    const { h, conn } = await setup();
    await h.reportsJob.run(LANE, conn.id);
    for (const [kind, ids] of [["ar_aging_summary", ["11", "12"]], ["ap_aging_summary", ["1", "2"]]] as const) {
      const rows = entry(h, kind).payload.Rows.Row;
      expect(rows.map((r) => [r.type, r.level, r.ColData[0]?.value, r.ColData[0]?.id])).toEqual([
        ["Data", 0, "", ids[0]], ["Data", 0, "", ids[1]], ["Header", 0, "", "3"], ["Data", 1, "", "4"], ["Summary", 0, "", undefined], ["Summary", 0, "TOTAL", undefined],
      ]);
      expect(rows[0]?.ColData.slice(1).map((c) => c.value)).toEqual(["100.00", "0.00", "0.00", "0.00", "0.00", "100.00"]);
      // the only label text left in the whole report is TOTAL
      expect(rows.filter((r) => r.ColData[0]?.value).map((r) => r.ColData[0]?.value)).toEqual(["TOTAL"]);
      const t = text(rows);
      for (const gone of ["Holdings", "100234", "555555", "Parent", "Job Alpha", "Customer", "Vendor"]) expect(t).not.toContain(gone);
    }
  });

  it("a malformed answer is refused for that report only; nothing of it is in the error", async () => {
    const { intuit, h, conn } = await setup();
    intuit.state.reports.CashFlow = { Header: "not an object", Rows: { Row: [{ ColData: "oops SECRET-ROW-TEXT" }] } };
    const out = await h.reportsJob.run(LANE, conn.id);
    expect(out).toMatchObject({ ok: false, retryable: false, errorKind: "provider_error" });
    expect(h.reportState.stored.map((e) => e.report)).toEqual(["pnl", "balance_sheet", "ar_aging_summary", "ap_aging_summary"]);
    expect(text(out)).not.toContain("SECRET-ROW-TEXT");
    expect(text(h.logs)).not.toContain("SECRET-ROW-TEXT");
  });

  it("a report in another accounting basis than asked is refused (mislabelled figures are not cached)", async () => {
    const { intuit, h, conn } = await setup();
    (intuit.state.reports.ProfitAndLoss as { Header: Record<string, unknown> }).Header.ReportBasis = "Cash";
    const out = await h.reportsJob.run(LANE, conn.id);
    expect(out).toMatchObject({ ok: false, errorKind: "provider_error" });
    expect(h.reportState.stored.some((e) => e.report === "pnl")).toBe(false);
    expect(h.reportState.stored).toHaveLength(4);
  });
});

describe("payroll (D-25, default (b)): payroll account rows are not cached, and an unreadable setting fails closed (acceptance)", () => {
  it("removes payroll sections and rows (by subtype, sub-account and name safety net), and counts them", async () => {
    const { h, conn } = await setup();
    await h.reportsJob.run(LANE, conn.id);
    const p = entry(h, "pnl").payload;
    const t = text(p);
    for (const gone of ["Team Costs", "Base Costs", "Salaries and Wages", "39000.00", "9000.00", "30000.00", "500.00"]) expect(t).not.toContain(gone);
    for (const id of REPORT_PAYROLL_ACCOUNT_IDS) expect(p.Rows.Row.some((r) => r.ColData.some((c) => c.id === id))).toBe(false);
    expect(p.Header.TotalsWithheld).toBe("true");
    // the other expenses stay, and so does the total of a section that lost nothing
    expect(t).toContain("Office Supplies");
    expect(t).toContain("1200.00");
    expect(p.Rows.Row.some((r) => r.type === "Summary" && r.ColData[0]?.value === "Total Income")).toBe(true);
  });

  it("withholds every total that could be subtracted to recover a removed row (D-25): totals above it and the computed ones", async () => {
    const { h, conn } = await setup();
    await h.reportsJob.run(LANE, conn.id);
    const summaries = entry(h, "pnl").payload.Rows.Row.filter((r) => r.type === "Summary").map((r) => r.ColData[0]?.value);
    expect(summaries).toEqual(["Total Income"]); // Total Expenses (above payroll) and Net Income (computed) are withheld
    const t = text(entry(h, "pnl").payload);
    for (const gone of ["Total Expenses", "Net Income", "40712.00", "111288.50"]) expect(t).not.toContain(gone);
    // nothing was removed from the other reports: their totals are kept and say so
    expect(entry(h, "balance_sheet").payload.Header.TotalsWithheld).toBe("false");
    expect(entry(h, "balance_sheet").payload.Rows.Row.some((r) => r.ColData[0]?.value === "Total ASSETS")).toBe(true);
    expect(entry(h, "cash_flow").payload.Rows.Row.some((r) => r.ColData[0]?.value === "CASH AT END OF PERIOD")).toBe(true);
  });

  it("a removed nested customer (a job) withholds its parent's total and the aging TOTAL", async () => {
    const { h, conn } = await setup();
    h.payrollState.settings = { ...h.payrollState.settings, excludedEntityIds: ["4"] };
    await h.reportsJob.run(LANE, conn.id);
    const ap = entry(h, "ap_aging_summary").payload;
    expect(ap.Rows.Row.map((r) => [r.type, r.ColData[0]?.id])).toEqual([["Data", "1"], ["Data", "2"], ["Header", "3"]]);
    expect(ap.Header.TotalsWithheld).toBe("true");
    expect(text(ap)).not.toContain("25.00");
  });

  it("a removed customer / vendor withholds that aging TOTAL; the other aging report keeps its TOTAL", async () => {
    const { h, conn } = await setup();
    h.payrollState.settings = { ...h.payrollState.settings, excludedEntityIds: ["2"] };
    await h.reportsJob.run(LANE, conn.id);
    const ap = entry(h, "ap_aging_summary").payload;
    expect(ap.Header.TotalsWithheld).toBe("true");
    expect(ap.Rows.Row.some((r) => r.ColData[0]?.value === "TOTAL")).toBe(false);
    expect(text(ap)).not.toContain("165.00");
    expect(ap.Rows.Row.filter((r) => r.type === "Data").map((r) => r.ColData[0]?.id)).toEqual(["1", "4"]);
    const ar = entry(h, "ar_aging_summary").payload;
    expect(ar.Header.TotalsWithheld).toBe("false");
    expect(ar.Rows.Row.some((r) => r.ColData[0]?.value === "TOTAL")).toBe(true);
  });

  it("configured account ids and excluded people are removed too", async () => {
    const { h, conn } = await setup({ accounts: syntheticReportAccounts().filter((a) => a.Id !== "60" && a.Id !== "61") });
    h.payrollState.settings = { accountIds: ["50"], accountSubtypes: [], excludedEntityIds: [] };
    await h.reportsJob.run(LANE, conn.id);
    expect(text(entry(h, "pnl").payload)).not.toContain("Office Supplies");
    h.reportState.stored.length = 0;
    h.payrollState.settings = { accountIds: [], accountSubtypes: [], excludedEntityIds: ["2"] };
    await h.reportsJob.run(LANE, conn.id);
    const ap = entry(h, "ap_aging_summary").payload.Rows.Row.filter((r) => r.type === "Data");
    expect(ap.map((r) => r.ColData[0]?.id)).toEqual(["1", "4"]);
    expect(entry(h, "ap_aging_summary").payload.Header.TotalsWithheld).toBe("true");
  });

  it("an unreadable payroll or report setting fails closed: no Intuit call, nothing cached", async () => {
    const a = await setup();
    a.h.payrollState.fail = true;
    expect(await a.h.reportsJob.run(LANE, a.conn.id)).toMatchObject({ ok: false });
    expect(a.intuit.state.apiRequests).toEqual([]);
    expect(a.h.reportState.stored).toEqual([]);
    const b = await setup();
    b.h.reportState.failSettings = true;
    expect(await b.h.reportsJob.run(LANE, b.conn.id)).toMatchObject({ ok: false, errorKind: "provider_error" });
    expect(b.intuit.state.apiRequests).toEqual([]);
    expect(b.h.reportState.stored).toEqual([]);
  });

  it("projection unit: an excluded id never survives, whatever the label", () => {
    const req = planReports({ method: "accrual", period: "year_to_date", classIds: [], kinds: ["pnl"] }, false, Date.now())[0]!;
    const policy: ReportPolicy = reportPolicy([{ Id: "9", Name: "Misc", AccountSubType: "PayrollTaxPayable" }], { accountIds: [], accountSubtypes: ["PayrollTaxPayable"], excludedEntityIds: [] });
    const out = projectReport(req, { Header: {}, Rows: { Row: [{ type: "Data", ColData: [{ value: "Perfectly Normal", id: "9" }, { value: "12.00" }] }, { type: "Data", ColData: [{ value: "Fine", id: "10" }, { value: "1.00" }] }] } }, policy);
    expect(out.payload.Rows.Row.map((r) => r.ColData[0]?.id)).toEqual(["10"]);
    expect(out.excludedRows).toBe(1);
    expect(out.payload.Header.TotalsWithheld).toBe("true");
  });
});

describe("lane and connection safety", () => {
  it("skips a connection that is not usable without calling Intuit", async () => {
    const { intuit, h, conn } = await setup();
    (h.rows.get(conn.id) as { status: string }).status = "reconnect_required";
    expect(await h.reportsJob.run(LANE, conn.id)).toEqual({ ok: true, skipped: "connection_not_usable" });
    expect(intuit.state.apiRequests).toEqual([]);
    expect(h.reportState.stored).toEqual([]);
  });

  it("another lane's connection id is not found; another provider's connection is refused before any call", async () => {
    const { intuit, h, conn } = await setup();
    expect(await h.reportsJob.run("APK", conn.id)).toMatchObject({ ok: false, errorKind: "not_found" });
    const foreign = h.addForeignConnection(LANE, "stripe");
    expect(await h.reportsJob.run(LANE, foreign.id)).toMatchObject({ ok: false, errorKind: "lane_mismatch" });
    expect(await h.reportsJob.run(LANE, "not-a-uuid")).toMatchObject({ ok: false, errorKind: "invalid_input" });
    expect(await h.reportsJob.run("pkg", conn.id)).toMatchObject({ ok: false });
    expect(intuit.state.apiRequests).toEqual([]);
    expect(h.reportState.stored).toEqual([]);
  });

  it("a store failure is reported after the other reports were tried, and is retryable when transient", async () => {
    const { h, conn } = await setup();
    h.reportState.failStore = { reports: "all", kind: "transient" };
    const out = await h.reportsJob.run(LANE, conn.id);
    expect(out).toMatchObject({ ok: false, retryable: true, errorKind: "transient" });
  });

  it("a report the cache refuses does not stop the other four, and is not retried", async () => {
    const { h, conn } = await setup();
    h.reportState.failStore = { reports: ["cash_flow"], kind: "provider_error" };
    const out = await h.reportsJob.run(LANE, conn.id);
    expect(out).toMatchObject({ ok: false, retryable: false, errorKind: "provider_error", stored: ["pnl", "balance_sheet", "ar_aging_summary", "ap_aging_summary"] });
    expect(h.reportState.stored).toHaveLength(4);
  });

  it("a transient failure is not hidden by an earlier permanent one (the run is retried)", async () => {
    const { intuit, h, conn } = await setup();
    intuit.state.reports.ProfitAndLoss = { Header: "not an object" }; // permanent, first
    h.reportState.failStore = { reports: ["ap_aging_summary"], kind: "transient" }; // transient, later
    const out = await h.reportsJob.run(LANE, conn.id);
    expect(out).toMatchObject({ ok: false, retryable: true, errorKind: "transient" });
    expect(h.reportState.stored.map((e) => e.report)).toEqual(["balance_sheet", "cash_flow", "ar_aging_summary"]);
  });

  it("logs counts and report names only", async () => {
    const { h, conn } = await setup();
    await h.reportsJob.run(LANE, conn.id);
    const t = text(h.logs);
    expect(t).toContain("qbo.reports.done");
    for (const secret of ["Operating Checking", "152000.50", "Subscription Income", "84210.55"]) expect(t).not.toContain(secret);
  });

  it("the client the job uses exposes GET only (a test fails on create, update, delete or batch)", async () => {
    const { h } = await setup();
    expect(Object.keys(h.api)).toEqual(["get"]);
  });
});
