// QuickBooks Reports API (T-052; QB-10 reports): ProfitAndLoss, BalanceSheet, CashFlow, AgedReceivables and AgedPayables,
// GET only, through `QboApi`. This file is the pure part: what to ask for, and how an answer is cut down to what may be
// stored in fin.report_cache. The runner (fetch, store, per-report failures) is ./reports-job.ts.
//
// Request (rule 2: nothing company-specific in code):
//  - date range from `lane_config.finance.reports.period` (calendar year to date, or the last 12 months, in
//    America/New_York); accounting method from `lane_config.finance.accounting_method`; class filter from the lane's own
//    entity classes (`entities.by_entity[own_entity].qbo_class_ids`).
//  - The class filter is sent only when the connection's class-tracking flag is on AND the report supports it (see
//    REPORT_DEFS.classFilter). Otherwise the report is fetched unsplit and `params` has no `class` (plus `unsplit` saying
//    why when a class was configured). `params.method` is present exactly when the accounting method was sent.
//  - `params` is the cache key (fin.report_cache.params, hashed by the database): every field that changes the figures
//    is in it, and nothing else is.
// Projection (the stored payload; a STRICT allowlist, everything else is dropped):
//  - top level `Header`, `Columns`, `Rows` only. Header keeps 8 scalar fields; Columns keeps title and type (no
//    MetaData); each cell keeps `value` and `id` (the account / customer / vendor Id: fin.accounts.source_id matches it).
//    No memo, description, link (`href`) or name column exists in these summary reports, and none is kept.
//  - Rows are FLATTENED: QuickBooks nests sections inside sections (Rows > Row > Rows > Row ...), which costs three JSON
//    levels per section and passes the database's 16-level key scan with a real BalanceSheet only by luck. The stored
//    rows are one list `Rows.Row[]` of { type: Header | Data | Summary, level, group?, ColData[] } in document order;
//    `level` is the section depth, so the tree can be rebuilt. Depth in the database: 5.
//  - Text is label text and can carry an account number ("Operating Checking 123456789"): a value with a letter has every
//    run of 5+ digits masked (the database refuses the same shape, fin.report_cache_guard). Figures (digits, one sign,
//    one decimal point) are kept as the strings Intuit sent: rule 7, SQL does the arithmetic.
//  - Aging summaries list one row per customer or vendor (and sections for sub-customers): the NAME is dropped on every
//    row, section header and "Total <name>" (value ""), the Id is kept; only the TOTAL row keeps its label. The drill-down
//    with names comes from fin.invoices / fin.bills.
//  - Payroll (D-25, default (b)): rows of payroll accounts (configured ids, payroll subtypes, name safety net, their
//    sub-accounts: the same classification as the entity sync) and of configured excluded people are removed, a section
//    whose header is one of them goes with its rows and total. A total is useful to read back only when it cannot be
//    subtracted to recover a removed row (total minus the visible rows = the payroll amount), so when a row was removed
//    every Summary above it is withheld (Total Expenses, Total Liabilities...), and so are the computed-only totals of
//    the report (Net Income, Gross Profit, the aging TOTAL); `Header.TotalsWithheld` says so. Totals are then computed in
//    SQL from the kept rows (rule 7). The AGGREGATE can still be recovered by someone who reads several cached
//    reports (CashFlow keeps "Net Income", the BalanceSheet keeps Total Assets and Equity): decision D-27.
// Records never appear in logs or errors; counts only.
import { z } from "zod";
import { ConnectorError } from "../contract/errors";
import { classifyPayrollAccounts, isPayrollLabel, maskDigitRuns } from "./entities";

export const QBO_REPORT_KINDS = ["pnl", "balance_sheet", "cash_flow", "ar_aging_summary", "ap_aging_summary"] as const;
export type QboReportKind = (typeof QBO_REPORT_KINDS)[number];

export type ReportDef = {
  /** Intuit's report name in the URL. */
  name: string;
  /** Sends start_date and end_date (true) or report_date (aging). */
  window: "range" | "report_date";
  /** `accounting_method` is a parameter of this report. */
  method: boolean;
  /**
   * `class` is honoured by this report. UNVERIFIED against Intuit for CashFlow, AgedReceivables and AgedPayables (only the
   * synthetic fake exists): they stay false, i.e. unsplit and marked, until the live check (H-035) says otherwise.
   */
  classFilter: boolean;
  /** Per-customer / per-vendor rows: names are dropped. */
  aging: boolean;
};

export const REPORT_DEFS: Record<QboReportKind, ReportDef> = {
  pnl: { name: "ProfitAndLoss", window: "range", method: true, classFilter: true, aging: false },
  balance_sheet: { name: "BalanceSheet", window: "range", method: true, classFilter: true, aging: false },
  cash_flow: { name: "CashFlow", window: "range", method: false, classFilter: false, aging: false },
  ar_aging_summary: { name: "AgedReceivables", window: "report_date", method: false, classFilter: false, aging: true },
  ap_aging_summary: { name: "AgedPayables", window: "report_date", method: false, classFilter: false, aging: true },
};

export type ReportSettings = {
  method: "accrual" | "cash";
  period: "year_to_date" | "trailing_12_months";
  /** The lane's own entity classes (empty = no class filter wanted). */
  classIds: string[];
  /** Report kinds to fetch and cache (`lane_config.finance.reports.kinds`; default excludes balance_sheet and cash_flow, D-27). */
  kinds: readonly QboReportKind[];
};

export type ReportRequest = {
  kind: QboReportKind;
  path: string;
  query: Record<string, string>;
  /** The fin.report_cache `params` of the result. */
  params: Record<string, string>;
};

export const BUSINESS_TZ = "America/New_York";
const CLASS_ID = /^\d{1,20}$/;

/** The calendar date (YYYY-MM-DD) in America/New_York at an instant. */
export function businessDate(ms: number): { y: number; m: number; d: number; iso: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const y = n("year"), m = n("month"), d = n("day");
  return { y, m, d, iso: `${String(y)}-${two(m)}-${two(d)}` };
}

const two = (v: number) => String(v).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${String(y)}-${two(m)}-${two(d)}`;

/**
 * First day (Saturday) of the business week (Sat-Fri, rule 11) that contains a New York calendar date. Pure calendar arithmetic
 * on the date (UTC fields of a UTC midnight), so no time zone or DST shift can move it.
 */
export function businessWeekStart(day: { y: number; m: number; d: number }): string {
  const t = Date.UTC(day.y, day.m - 1, day.d);
  const dow = new Date(t).getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const back = (dow + 1) % 7; // Saturday 0, Sunday 1 ... Friday 6
  const s = new Date(t - back * 86_400_000);
  return ymd(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate());
}

/**
 * The requests for a connection at an instant, for the configured kinds. Pure.
 *
 * The P&L is requested for the configured period (as before) AND, so the Finance page and Home can read it, for this business
 * week to date, this month to date and this calendar year to date (T-244): same end date (today, New York), same method and class
 * rules. Windows with the same start are one request (Saturday: week = today; the 1st: month = today; Jan 1; year-to-date
 * configured). The extras come after the configured kinds. Nothing is added to `params` for them: the date range is the key, and
 * a request of the same range is the same cached figure. Calendar year, not fiscal: no fiscal-year start exists in lane_config.
 */
export function planReports(settings: ReportSettings, classTracking: boolean, nowMs: number): ReportRequest[] {
  const today = businessDate(nowMs);
  let start: string;
  if (settings.period === "year_to_date") {
    start = `${String(today.y)}-01-01`;
  } else {
    // First day of the month 11 months back: twelve calendar months including this one.
    const back = today.m - 11;
    start = back >= 1 ? `${String(today.y)}-${two(back)}-01` : `${String(today.y - 1)}-${two(back + 12)}-01`;
  }
  const classIds = [...new Set(settings.classIds)].filter((c) => CLASS_ID.test(c)).sort();
  const build = (kind: QboReportKind, from: string): ReportRequest => {
    const def = REPORT_DEFS[kind];
    const query: Record<string, string> = {};
    const params: Record<string, string> = {};
    if (def.window === "range") {
      query.start_date = from;
      query.end_date = today.iso;
      params.start_date = from;
      params.end_date = today.iso;
    } else {
      query.report_date = today.iso;
      params.report_date = today.iso;
    }
    if (def.method) {
      query.accounting_method = settings.method === "cash" ? "Cash" : "Accrual";
      params.method = settings.method;
    }
    if (classIds.length > 0) {
      if (classTracking && def.classFilter) {
        query.class = classIds.join(",");
        params.class = classIds.join(",");
      } else {
        params.unsplit = !classTracking ? "class_tracking_off" : "report_not_class_aware";
      }
    }
    return { kind, path: `/v3/company/{realm}/reports/${def.name}`, query, params };
  };
  const requests = QBO_REPORT_KINDS.filter((k) => settings.kinds.includes(k)).map((kind) => build(kind, start));
  if (settings.kinds.includes("pnl")) {
    const seen = new Set([start]);
    for (const from of [businessWeekStart(today), ymd(today.y, today.m, 1), `${String(today.y)}-01-01`]) {
      if (seen.has(from)) continue;
      seen.add(from);
      requests.push(build("pnl", from));
    }
  }
  return requests;
}

// ------------------------------------------------------------------------------------------------------ projection

const MAX_LEVEL = 10;
const MAX_ROWS = 20_000;
const MAX_COLUMNS = 64;
/** Of the JSON text; the database caps the jsonb text at 4 MiB and prints longer than JSON. */
export const REPORT_MAX_BYTES = 2_500_000;

const Cell = z.object({ value: z.string().max(512).optional(), id: z.string().max(64).optional() });
const CellList = z.object({ ColData: z.array(Cell).max(MAX_COLUMNS) });
const RowNode = z.object({
  type: z.string().max(32).optional(),
  group: z.string().max(64).optional(),
  Header: CellList.optional(),
  Summary: CellList.optional(),
  ColData: z.array(Cell).max(MAX_COLUMNS).optional(),
  Rows: z.object({ Row: z.array(z.unknown()).max(MAX_ROWS) }).optional(),
});
const ColumnNode = z.object({ ColTitle: z.string().max(128).optional(), ColType: z.string().max(32).optional() });
const ReportIn = z.object({
  Header: z.object({
    Time: z.string().max(64).optional(),
    ReportName: z.string().max(64).optional(),
    ReportBasis: z.string().max(16).optional(),
    StartPeriod: z.string().max(16).optional(),
    EndPeriod: z.string().max(16).optional(),
    Currency: z.string().max(8).optional(),
    SummarizeColumnsBy: z.string().max(32).optional(),
  }),
  Columns: z.object({ Column: z.array(ColumnNode).max(MAX_COLUMNS).optional() }).optional(),
  Rows: z.object({ Row: z.array(z.unknown()).max(MAX_ROWS).optional() }).optional(),
});

const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:?[0-9]{2})$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const FIGURE = /^-?[0-9]{1,15}(\.[0-9]{1,6})?$/;
// QuickBooks Ids are digits. Anything else is dropped: a letter next to 5 digits would trip the database's value guard.
const SAFE_ID = /^[0-9]{1,20}$/;
const GROUP = /^[A-Za-z]{1,64}$/;
const WORD = /^[A-Za-z]{1,64}$/;

/** Label text: NFKC, and when it has a letter (or a non-ASCII character) every run of 5+ digits is masked. Mirrors the database rule. */
export function maskLabel(text: string): string {
  const t = text.normalize("NFKC");
  return /[A-Za-z]|[^\p{ASCII}]/u.test(t) ? maskDigitRuns(t, 5) : t;
}

const bad = (message: string, tid: string | null) => new ConnectorError({ kind: "provider_error", message, provider_tid: tid });

export type ReportPolicy = {
  /** Account Ids classified as payroll (classifyPayrollAccounts). */
  payrollAccountIds: ReadonlySet<string>;
  /** Customer / vendor Ids from lane_config.finance.payroll.excluded_entity_ids. */
  excludedEntityIds: ReadonlySet<string>;
};

export type ProjectedReport = {
  payload: { Header: Record<string, string>; Columns: { Column: { ColTitle: string; ColType: string }[] }; Rows: { Row: FlatRow[] } };
  /** The instant Intuit produced the report (Header.Time), or null when absent or unreadable. */
  producedAt: string | null;
  excludedRows: number;
};
export type FlatRow = { type: "Header" | "Data" | "Summary"; level: number; group?: string; ColData: { value: string; id?: string }[] };

/**
 * Cuts a report answer down to the stored shape. `request` is checked against the answer: a report in another accounting
 * basis than asked is refused (figures would be mislabelled). Throws a provider_error on any shape problem; the report is
 * then not stored (fail closed), and nothing of the answer is in the message.
 */
export function projectReport(request: ReportRequest, raw: unknown, policy: ReportPolicy, tid: string | null = null): ProjectedReport {
  const def = REPORT_DEFS[request.kind];
  const parsed = ReportIn.safeParse(raw);
  if (!parsed.success) throw bad("Report response is not valid", tid);
  const { Header: h, Columns: c, Rows: r } = parsed.data;

  const header: Record<string, string> = {};
  let producedAt: string | null = null;
  if (h.Time !== undefined && INSTANT.test(h.Time) && !Number.isNaN(Date.parse(h.Time))) {
    producedAt = new Date(h.Time).toISOString();
    header.Time = producedAt;
  }
  if (h.ReportName !== undefined && WORD.test(h.ReportName)) header.ReportName = h.ReportName;
  if (h.Currency !== undefined && /^[A-Z]{3}$/.test(h.Currency)) header.Currency = h.Currency;
  if (h.SummarizeColumnsBy !== undefined && WORD.test(h.SummarizeColumnsBy)) header.SummarizeColumnsBy = h.SummarizeColumnsBy;
  if (h.StartPeriod !== undefined && DATE.test(h.StartPeriod)) header.StartPeriod = h.StartPeriod;
  if (h.EndPeriod !== undefined && DATE.test(h.EndPeriod)) header.EndPeriod = h.EndPeriod;
  if (h.ReportBasis !== undefined) {
    if (!/^(accrual|cash)$/i.test(h.ReportBasis)) throw bad("Report basis is not valid", tid);
    const basis = h.ReportBasis.toLowerCase();
    if (request.params.method !== undefined && basis !== request.params.method) throw bad("Report basis differs from the request", tid);
    header.ReportBasis = basis === "cash" ? "Cash" : "Accrual";
  }

  const columns = (c?.Column ?? []).map((col) => ({ ColTitle: maskLabel(col.ColTitle ?? ""), ColType: col.ColType !== undefined && WORD.test(col.ColType) ? col.ColType : "" }));

  const out: FlatRow[] = [];
  let excluded = 0;
  const isExcluded = (cells: readonly { value?: string | undefined; id?: string | undefined }[]): boolean => {
    const first = cells[0];
    if (!first) return false;
    if (first.id !== undefined && (policy.payrollAccountIds.has(first.id) || policy.excludedEntityIds.has(first.id))) return true;
    // Aging names are dropped anyway; elsewhere the label is the account name (the same safety net as the account classification).
    return !def.aging && first.value !== undefined && isPayrollLabel(first.value);
  };
  const cells = (list: readonly { value?: string | undefined; id?: string | undefined }[], dropName: boolean) =>
    list.map((cell, i) => {
      const text = cell.value ?? "";
      const value = i === 0 ? (dropName ? "" : maskLabel(text)) : FIGURE.test(text) ? text : maskLabel(text);
      return cell.id !== undefined && SAFE_ID.test(cell.id) ? { value, id: cell.id } : { value };
    });
  const push = (type: FlatRow["type"], level: number, group: string | undefined, list: Parameters<typeof cells>[0], dropName: boolean) => {
    if (out.length >= MAX_ROWS) throw bad("Report has too many rows", tid);
    out.push({ type, level, ...(group !== undefined && GROUP.test(group) ? { group } : {}), ColData: cells(list, dropName) });
  };
  /** Counts a skipped subtree (its own row, header, summary and every row below). */
  const countAll = (node: z.infer<typeof RowNode>): number => {
    let n = (node.Header ? 1 : 0) + (node.Summary ? 1 : 0) + (node.ColData ? 1 : 0);
    for (const child of node.Rows?.Row ?? []) {
      const p = RowNode.safeParse(child);
      if (p.success) n += countAll(p.data);
    }
    return n;
  };

  /** Indexes in `out` of computed-only totals (a section with just a Summary: Net Income, Gross Profit, the aging TOTAL...). */
  const computedOnly = new Set<number>();
  const walk = (rows: readonly unknown[], level: number, parentGroup: string | undefined): void => {
    if (level > MAX_LEVEL) throw bad("Report is nested too deeply", tid);
    for (const item of rows) {
      const p = RowNode.safeParse(item);
      if (!p.success) throw bad("A report row does not match the expected shape", tid);
      const node = p.data;
      const group = node.group ?? parentGroup;
      if (node.Header && isExcluded(node.Header.ColData)) {
        excluded += countAll(node);
        continue;
      }
      const before = excluded;
      // Aging summaries: customer and vendor names are dropped on every row (section headers and "Total <name>" too).
      if (node.Header) push("Header", level, node.group, node.Header.ColData, def.aging);
      if (node.ColData) {
        if (isExcluded(node.ColData)) excluded += 1;
        else push("Data", level, group, node.ColData, def.aging);
      }
      if (node.Rows) walk(node.Rows.Row, level + 1, group);
      if (node.Summary) {
        if (isExcluded(node.Summary.ColData)) {
          excluded += 1;
        } else if (excluded === before) {
          // A total is kept only when nothing below it was removed: a total that included a removed row would give that
          // row back by subtraction (D-25).
          const label = node.Summary.ColData[0]?.value ?? "";
          const keepName = !def.aging || /^total$/i.test(label.trim());
          if (!node.Header && !node.ColData && (node.Rows?.Row.length ?? 0) === 0) computedOnly.add(out.length);
          push("Summary", level, node.group, node.Summary.ColData, !keepName);
        }
      }
    }
  };
  walk(r?.Row ?? [], 0, undefined);

  // Computed totals that are not on a path to a removed row (Net Income = Income - Expenses...) still include it: with
  // anything removed from this report they go too. Totals of sections that lost nothing stay.
  const rows = excluded > 0 ? out.filter((_row, i) => !computedOnly.has(i)) : out;
  header.TotalsWithheld = excluded > 0 ? "true" : "false";
  const payload = { Header: header, Columns: { Column: columns }, Rows: { Row: rows } };
  return { payload, producedAt, excludedRows: excluded };
}

/** The payroll classification for a run from the lane's Account list and settings (shared with the entity sync). */
export function reportPolicy(accounts: readonly unknown[], payroll: { accountIds: readonly string[]; accountSubtypes: readonly string[]; excludedEntityIds: readonly string[] }): ReportPolicy {
  return { payrollAccountIds: classifyPayrollAccounts(accounts, payroll), excludedEntityIds: new Set(payroll.excludedEntityIds) };
}
