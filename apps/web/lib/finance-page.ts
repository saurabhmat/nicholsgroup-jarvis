// Finance page (T-244): net income for the selected period (core.finance_pnl) and the overview (core.finance_overview: open AR total,
// cached report METADATA). Cash, bills, aging and the unmapped counts come from the same reads Home uses (home-finance.ts,
// home-finance-detail.ts). Every figure is computed in SQL (rule 7); this file maps rows defensively, formats, and chooses the
// words for empty states. It never adds, subtracts or estimates a figure, and never shows a sample number.
import type { Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import { count, formatAsOf, instant, num, text, type FinanceState } from "./home-finance";

export const PERIOD_KEYS = ["week", "mtd", "ytd"] as const;
export type FinancePeriod = (typeof PERIOD_KEYS)[number];
export const DEFAULT_PERIOD: FinancePeriod = "mtd";
export const PERIOD_LABEL: Record<FinancePeriod, string> = { week: "This week (Sat–Fri)", mtd: "Month to date", ytd: "Year to date" };

/** The `?period=` search param: anything but one of the three keys (unknown, repeated, missing) is the default. */
export function parsePeriod(value: unknown): FinancePeriod {
  return typeof value === "string" && (PERIOD_KEYS as readonly string[]).includes(value) ? (value as FinancePeriod) : DEFAULT_PERIOD;
}

const STATES: readonly string[] = ["not_connected", "no_data", "mapping_missing", "ok", "no_access"];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymd = (v: unknown): string | null => (typeof v === "string" && YMD.test(v.slice(0, 10)) ? v.slice(0, 10) : null);

// ---------------------------------------------------------------------------------------------------------- net income

export type FinancePnl =
  | { state: "unavailable" }
  | { state: "no_access" }
  | {
      state: Exclude<FinanceState, "no_access">;
      period: FinancePeriod;
      asOf: string | null;
      /** The requested window (calendar dates, America/New_York), also when nothing is cached. */
      windowStart: string | null;
      windowEnd: string | null;
      reason: string | null;
      income: number | null;
      expenses: number | null;
      net: number | null;
      start: string | null;
      end: string | null;
      method: string | null;
      partial: boolean;
      reportAsOf: string | null;
    };

export function toFinancePnl(data: unknown, period: FinancePeriod): FinancePnl {
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row || typeof row.state !== "string" || !STATES.includes(row.state) || row.state === "no_access") return { state: "no_access" };
  return {
    state: row.state as Exclude<FinanceState, "no_access">,
    period,
    asOf: instant(row.as_of),
    windowStart: ymd(row.window_start),
    windowEnd: ymd(row.window_end),
    reason: text(row.pnl_reason),
    income: num(row.pnl_income),
    expenses: num(row.pnl_expenses),
    net: num(row.pnl_net),
    start: ymd(row.pnl_start),
    end: ymd(row.pnl_end),
    method: text(row.pnl_method),
    partial: row.pnl_partial === true,
    reportAsOf: instant(row.pnl_as_of),
  };
}

type Db = Pick<LaneClient, "schema">;

export async function loadFinancePnl(client: Db, laneId: string, period: FinancePeriod): Promise<FinancePnl> {
  const { data, error } = await client.schema("core").rpc("finance_pnl", { p_lane: laneId, p_period: period });
  if (error) throw new Error("finance net income unavailable");
  return toFinancePnl(data, period);
}

export async function financePnlFor(g: Pick<Guards, "requireLane">, laneId: string, period: FinancePeriod, load = loadFinancePnl): Promise<FinancePnl> {
  try {
    const { client } = await g.requireLane(laneId as Parameters<Guards["requireLane"]>[0]);
    return await load(client, laneId, period);
  } catch (e) {
    console.error("[finance] net income unavailable", { laneId, reason: e instanceof Error ? e.name : typeof e });
    return { state: "unavailable" };
  }
}

const PNL_REASONS: Record<string, string> = {
  report_not_cached: "The report for this period is not synced yet. QuickBooks reports are fetched nightly",
  report_not_split_by_class: "The report is not split by class yet",
  report_has_columns: "The report could not be read",
  figure_unreadable: "The report could not be read",
  report_empty: "No income or expense lines in this period",
};
export const pnlReasonText = (reason: string): string => PNL_REASONS[reason] ?? "Not available yet";

// ---------------------------------------------------------------------------------------------------------- overview

export type CachedReport = { report: string; startDate: string | null; endDate: string | null; reportDate: string | null; method: string | null; classFiltered: boolean; asOf: string };

export type FinanceOverview =
  | { state: "unavailable" }
  | { state: "no_access" }
  | {
      state: Exclude<FinanceState, "no_access">;
      asOf: string | null;
      lastSyncAt: string | null;
      lastNormalizedAt: string | null;
      connectionStatus: string | null;
      /** Open AR of the own entity: equals the sum of the aging buckets (SQL). */
      arTotal: number | null;
      arInvoices: number;
      unmappedBillsOpen: number;
      reports: CachedReport[];
    };

function toReports(v: unknown): CachedReport[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x: unknown) => {
    if (typeof x !== "object" || x === null) return [];
    const r = x as Record<string, unknown>;
    const report = text(r.report);
    const asOf = instant(r.as_of);
    if (!report || !asOf) return [];
    return [{ report, startDate: ymd(r.start_date), endDate: ymd(r.end_date), reportDate: ymd(r.report_date), method: text(r.method), classFiltered: r.class_filtered === true, asOf }];
  });
}

export function toFinanceOverview(data: unknown): FinanceOverview {
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row || typeof row.state !== "string" || !STATES.includes(row.state) || row.state === "no_access") return { state: "no_access" };
  return {
    state: row.state as Exclude<FinanceState, "no_access">,
    asOf: instant(row.as_of),
    lastSyncAt: instant(row.last_sync_at),
    lastNormalizedAt: instant(row.last_normalized_at),
    connectionStatus: text(row.connection_status),
    arTotal: num(row.ar_total),
    arInvoices: count(row.ar_invoices),
    unmappedBillsOpen: count(row.unmapped_bills_open),
    reports: toReports(row.reports),
  };
}

export async function loadFinanceOverview(client: Db, laneId: string): Promise<FinanceOverview> {
  const { data, error } = await client.schema("core").rpc("finance_overview", { p_lane: laneId });
  if (error) throw new Error("finance overview unavailable");
  return toFinanceOverview(data);
}

export async function financeOverviewFor(g: Pick<Guards, "requireLane">, laneId: string, load = loadFinanceOverview): Promise<FinanceOverview> {
  try {
    const { client } = await g.requireLane(laneId as Parameters<Guards["requireLane"]>[0]);
    return await load(client, laneId);
  } catch (e) {
    console.error("[finance] overview unavailable", { laneId, reason: e instanceof Error ? e.name : typeof e });
    return { state: "unavailable" };
  }
}

// ---------------------------------------------------------------------------------------------------------- wording

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/** "Nov 14, 2026" for a YYYY-MM-DD calendar date (no time zone shift). */
export const formatDay = (d: string): string => DAY.format(new Date(`${d}T00:00:00Z`));

/** "Nov 1, 2026 – Nov 14, 2026", or one day when both ends are the same. */
export const formatRange = (start: string, end: string): string => (start === end ? formatDay(start) : `${formatDay(start)} – ${formatDay(end)}`);

const REPORT_LABEL: Record<string, string> = {
  pnl: "Profit and loss",
  balance_sheet: "Balance sheet",
  cash_flow: "Cash flow",
  ar_aging_summary: "Receivables aging (AR)",
  ap_aging_summary: "Payables aging (AP)",
};
export const reportLabel = (report: string): string => REPORT_LABEL[report] ?? "Report";

/** One line per cached report: what it covers and when it was cached. Metadata only. */
export function reportLine(r: CachedReport): { title: string; covers: string; cached: string } {
  const covers = r.startDate && r.endDate ? formatRange(r.startDate, r.endDate) : r.reportDate ? `As of ${formatDay(r.reportDate)}` : "Date range not recorded";
  const basis = r.method ? `${r.method === "cash" ? "Cash" : "Accrual"} basis` : null;
  return { title: reportLabel(r.report), covers: basis ? `${covers} · ${basis}` : covers, cached: `Cached ${formatAsOf(r.asOf)}` };
}

export type ControlStatus = "ok" | "warn";
export type ControlRow = { key: string; label: string; status: ControlStatus; text: string };

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/**
 * The checks that exist in data today (spec finance.md 4.5: disconnected feeds, shared bank account, unmapped entity). Counts come
 * from SQL; "ok" or "warn" only compares them with zero or looks at the connection status. Reconciliation, bank feed health and
 * uncategorised transactions have no source yet (CONTROLS_MISSING).
 */
export function controlRows(input: {
  connectionStatus: string | null;
  lastSyncAt: string | null;
  lastNormalizedAt: string | null;
  unmappedBankAccounts: number;
  unmappedInvoices: number | null;
  unmappedBills: number | null;
  sharedAccountNames: string[];
}): ControlRow[] {
  const status = input.connectionStatus;
  const connected = status === "active";
  const conn: ControlRow = {
    key: "quickbooks_connection",
    label: "QuickBooks connection",
    status: connected ? "ok" : "warn",
    text: connected ? "Connected" : status === "reconnect_required" ? "Needs reconnecting" : status === "degraded" ? "Has problems" : "Not active",
  };
  const rows: ControlRow[] = [
    conn,
    { key: "last_sync", label: "Last QuickBooks sync", status: input.lastSyncAt ? "ok" : "warn", text: input.lastSyncAt ? formatAsOf(input.lastSyncAt) : "Not synced yet" },
    { key: "last_processed", label: "Last data processing", status: input.lastNormalizedAt ? "ok" : "warn", text: input.lastNormalizedAt ? formatAsOf(input.lastNormalizedAt) : "Not processed yet" },
    {
      key: "unmapped_bank_accounts",
      label: "Bank accounts not mapped to a company",
      status: input.unmappedBankAccounts === 0 ? "ok" : "warn",
      text: input.unmappedBankAccounts === 0 ? "None" : plural(input.unmappedBankAccounts, "account", "accounts"),
    },
  ];
  if (input.unmappedInvoices !== null) {
    rows.push({ key: "unmapped_invoices", label: "Open invoices with no company", status: input.unmappedInvoices === 0 ? "ok" : "warn", text: input.unmappedInvoices === 0 ? "None" : plural(input.unmappedInvoices, "invoice", "invoices") });
  }
  if (input.unmappedBills !== null) {
    rows.push({ key: "unmapped_bills", label: "Open bills with no company", status: input.unmappedBills === 0 ? "ok" : "warn", text: input.unmappedBills === 0 ? "None" : plural(input.unmappedBills, "bill", "bills") });
  }
  rows.push({
    key: "shared_bank_account",
    label: "Shared bank accounts",
    status: input.sharedAccountNames.length === 0 ? "ok" : "warn",
    text: input.sharedAccountNames.length === 0 ? "None" : input.sharedAccountNames.join(", "),
  });
  return rows;
}

export const CONTROLS_MISSING =
  "Reconciliation, bank feed health and uncategorised transaction checks are not available yet. They need reconciliation status to be entered, and QuickBooks does not expose bank feed health.";
export const REPORTS_MISSING = "The weekly cash report (Sat–Fri) and month-end snapshots are not generated yet. They appear here once those reports exist.";
