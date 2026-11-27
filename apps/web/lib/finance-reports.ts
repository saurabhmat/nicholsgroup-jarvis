// The controller's reports in the Finance section (T-300 aged AR by customer, T-301 invoices and received payments by week; spec
// finance.md section 15). Every figure is computed in SQL (core.finance_receivables, core.finance_weekly, core.finance_week_detail:
// SECURITY INVOKER, RLS: AAL2 + the lane's finance view, current QuickBooks connections only). This file maps the rows defensively,
// formats, and chooses the words; it never adds, subtracts or estimates a figure, and never shows a sample number (rule 7).
import type { Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import { count, instant, num, text, type FinanceState } from "./home-finance";
import { AGING_BUCKETS, toAging, type AgingBucket, type AgingRow } from "./home-finance-detail";

const STATES: readonly string[] = ["not_connected", "no_data", "mapping_missing", "ok", "no_access"];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymd = (v: unknown): string | null => (typeof v === "string" && YMD.test(v.slice(0, 10)) ? v.slice(0, 10) : null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const rowOf = (data: unknown): Record<string, unknown> | undefined => (Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined);
const stateOf = (row: Record<string, unknown> | undefined): Exclude<FinanceState, "no_access"> | null =>
  row && typeof row.state === "string" && STATES.includes(row.state) && row.state !== "no_access" ? (row.state as Exclude<FinanceState, "no_access">) : null;

// ---------------------------------------------------------------------------------------------------------- tabs

export type FinanceTabKey = "overview" | "receivables" | "weekly";
/** The tab row of the Finance section (spec 15.1). The Cash tab (T-302) is added with that task. Links, not client state. */
export const FINANCE_TABS: readonly { key: FinanceTabKey; label: string; segment: string }[] = [
  { key: "overview", label: "Overview", segment: "finance" },
  { key: "receivables", label: "Receivables", segment: "finance/receivables" },
  { key: "weekly", label: "Invoices & payments", segment: "finance/weekly" },
];

// ---------------------------------------------------------------------------------------------------------- receivables (T-300)

export type ReceivableInvoice = { issueDate: string | null; dueDate: string | null; daysOverdue: number; balance: number };
export type ReceivableCustomer = {
  /** null: no name stored (the page says "Unknown customer"). */
  name: string | null;
  buckets: Record<AgingBucket, number>;
  total: number;
  invoices: number;
  /** Oldest first, at most the per-customer cap; `detailShown` of `invoices`. */
  detail: ReceivableInvoice[];
  detailShown: number;
};
export type ArCheck =
  | { kind: "ok"; total: number; reportDate: string; difference: number }
  | { kind: "missing"; reason: "not_cached" | "withheld" | "older_than_data" | "unreadable" };

export type Receivables =
  | { state: "unavailable" }
  | { state: "no_access" }
  | {
      state: Exclude<FinanceState, "no_access">;
      asOf: string | null;
      lastSyncAt: string | null;
      connectionStatus: string | null;
      businessDate: string | null;
      /** The five buckets in order (SQL), else []. Equal to the Overview aging. */
      buckets: AgingRow[];
      total: number | null;
      invoiceCount: number;
      customers: ReceivableCustomer[];
      customerCount: number;
      customersShown: number;
      customerCap: number;
      invoiceCap: number;
      check: ArCheck | null;
    };

function toInvoices(v: unknown): ReceivableInvoice[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x: unknown) => {
    if (!isRecord(x)) return [];
    const balance = num(x.balance);
    const days = num(x.days_overdue);
    if (balance === null || days === null) return [];
    return [{ issueDate: ymd(x.issue_date), dueDate: ymd(x.due_date), daysOverdue: Math.max(0, Math.floor(days)), balance }];
  });
}

function toCustomers(v: unknown): ReceivableCustomer[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x: unknown) => {
    if (!isRecord(x)) return [];
    const total = num(x.total);
    const parts = AGING_BUCKETS.map((b) => num(x[b]));
    if (total === null || parts.some((p) => p === null)) return [];
    const buckets = Object.fromEntries(AGING_BUCKETS.map((b, i) => [b, parts[i] as number])) as Record<AgingBucket, number>;
    const detail = toInvoices(x.detail);
    return [{ name: text(x.name), buckets, total, invoices: count(x.invoices), detail, detailShown: Math.min(count(x.detail_shown), detail.length) }];
  });
}

const CHECK_REASONS = ["not_cached", "withheld", "older_than_data", "unreadable"] as const;
function toCheck(row: Record<string, unknown>): ArCheck | null {
  const reason = text(row.check_reason);
  if (reason !== null) {
    const r = CHECK_REASONS.find((c) => c === reason);
    return { kind: "missing", reason: r ?? "unreadable" };
  }
  const total = num(row.check_total);
  const difference = num(row.check_difference);
  const reportDate = ymd(row.check_report_date);
  return total !== null && difference !== null && reportDate !== null ? { kind: "ok", total, reportDate, difference } : null;
}

export function toReceivables(data: unknown): Receivables {
  const row = rowOf(data);
  const state = stateOf(row);
  if (!row || state === null) return { state: "no_access" };
  if (state !== "ok") {
    return { state, asOf: instant(row.as_of), lastSyncAt: instant(row.last_sync_at), connectionStatus: text(row.connection_status), businessDate: ymd(row.business_date), buckets: [], total: null, invoiceCount: 0, customers: [], customerCount: 0, customersShown: 0, customerCap: 0, invoiceCap: 0, check: null };
  }
  const customers = toCustomers(row.customers);
  return {
    state,
    asOf: instant(row.as_of),
    lastSyncAt: instant(row.last_sync_at),
    connectionStatus: text(row.connection_status),
    businessDate: ymd(row.business_date),
    buckets: toAging(row.buckets),
    total: num(row.total),
    invoiceCount: count(row.invoice_count),
    customers,
    customerCount: count(row.customer_count),
    customersShown: Math.min(count(row.customers_shown), customers.length),
    customerCap: count(row.customer_cap),
    invoiceCap: count(row.invoice_cap),
    check: toCheck(row),
  };
}

// ---------------------------------------------------------------------------------------------------------- weekly (T-301)

export type WeekRow = {
  /** Saturday, YYYY-MM-DD (America/New_York). */
  start: string;
  /** Friday. For the current week the figures run to `through` (today). */
  end: string;
  through: string;
  isCurrent: boolean;
  invoicedCount: number;
  invoicedAmount: number;
  receivedCount: number;
  receivedAmount: number;
};
export type FinanceWeekly =
  | { state: "unavailable" }
  | { state: "no_access" }
  | { state: Exclude<FinanceState, "no_access">; asOf: string | null; lastSyncAt: string | null; connectionStatus: string | null; businessDate: string | null; weeks: WeekRow[] };

function toWeeks(v: unknown): WeekRow[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x: unknown) => {
    if (!isRecord(x)) return [];
    const start = ymd(x.start);
    const end = ymd(x.end);
    const through = ymd(x.through);
    const invoicedAmount = num(x.invoiced_amount);
    const receivedAmount = num(x.received_amount);
    if (!start || !end || !through || invoicedAmount === null || receivedAmount === null) return [];
    return [{ start, end, through, isCurrent: x.is_current === true, invoicedCount: count(x.invoiced_count), invoicedAmount, receivedCount: count(x.received_count), receivedAmount }];
  });
}

export function toFinanceWeekly(data: unknown): FinanceWeekly {
  const row = rowOf(data);
  const state = stateOf(row);
  if (!row || state === null) return { state: "no_access" };
  return { state, asOf: instant(row.as_of), lastSyncAt: instant(row.last_sync_at), connectionStatus: text(row.connection_status), businessDate: ymd(row.business_date), weeks: state === "ok" ? toWeeks(row.weeks) : [] };
}

export type WeekInvoice = { customer: string | null; date: string | null; total: number; openBalance: number };
export type WeekPayment = { customer: string | null; date: string | null; amount: number };
export type WeekDetail =
  | { state: "unavailable" }
  | { state: "none" }
  | { state: "ok"; start: string; end: string; invoices: WeekInvoice[]; invoiceCount: number; payments: WeekPayment[]; paymentCount: number; rowCap: number };

export function toWeekDetail(data: unknown): WeekDetail {
  const row = rowOf(data);
  if (!row || stateOf(row) !== "ok" || row.week_valid !== true) return { state: "none" };
  const start = ymd(row.week_start);
  const end = ymd(row.week_end);
  if (!start || !end) return { state: "none" };
  const invoices = (Array.isArray(row.invoices) ? row.invoices : []).flatMap((x: unknown): WeekInvoice[] => {
    if (!isRecord(x)) return [];
    const total = num(x.total);
    const openBalance = num(x.open_balance);
    return total === null || openBalance === null ? [] : [{ customer: text(x.customer), date: ymd(x.date), total, openBalance }];
  });
  const payments = (Array.isArray(row.payments) ? row.payments : []).flatMap((x: unknown): WeekPayment[] => {
    if (!isRecord(x)) return [];
    const amount = num(x.amount);
    return amount === null ? [] : [{ customer: text(x.customer), date: ymd(x.date), amount }];
  });
  return { state: "ok", start, end, invoices, invoiceCount: Math.max(count(row.invoice_count), invoices.length), payments, paymentCount: Math.max(count(row.payment_count), payments.length), rowCap: count(row.row_cap) };
}

/** The `?week=YYYY-MM-DD` search param: a real calendar date or nothing. The database decides whether it is a Saturday in the shown range. */
export function parseWeek(value: unknown): string | null {
  if (typeof value !== "string" || !YMD.test(value)) return null;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value ? null : value;
}

// ---------------------------------------------------------------------------------------------------------- loading

type Db = Pick<LaneClient, "schema">;
type G = Pick<Guards, "requireLane">;

export async function loadReceivables(client: Db, laneId: string): Promise<Receivables> {
  const { data, error } = await client.schema("core").rpc("finance_receivables", { p_lane: laneId });
  if (error) throw new Error("finance receivables unavailable");
  return toReceivables(data);
}

/** The number of weeks is lane_config `finance.reports.weeks` (default 4): the database reads it, a finance reader needs no config view. */
export async function loadFinanceWeekly(client: Db, laneId: string): Promise<FinanceWeekly> {
  const { data, error } = await client.schema("core").rpc("finance_weekly", { p_lane: laneId });
  if (error) throw new Error("finance weekly unavailable");
  return toFinanceWeekly(data);
}

export async function loadWeekDetail(client: Db, laneId: string, week: string): Promise<WeekDetail> {
  const { data, error } = await client.schema("core").rpc("finance_week_detail", { p_lane: laneId, p_week: week });
  if (error) throw new Error("finance week detail unavailable");
  return toWeekDetail(data);
}

async function guarded<T>(g: G, laneId: string, what: string, load: (client: Db) => Promise<T>): Promise<T | { state: "unavailable" }> {
  try {
    const { client } = await g.requireLane(laneId as Parameters<Guards["requireLane"]>[0]);
    return await load(client);
  } catch (e) {
    console.error(`[finance] ${what} unavailable`, { laneId, reason: e instanceof Error ? e.name : typeof e });
    return { state: "unavailable" };
  }
}

/** The lane gate has already run on the page; an outage gives `unavailable`, never an empty or invented figure. */
export const receivablesFor = (g: G, laneId: string, load = loadReceivables): Promise<Receivables> => guarded(g, laneId, "receivables", (c) => load(c, laneId));
export const financeWeeklyFor = (g: G, laneId: string, load = loadFinanceWeekly): Promise<FinanceWeekly> => guarded(g, laneId, "weekly", (c) => load(c, laneId));
export async function weekDetailFor(g: G, laneId: string, week: string | null, load = loadWeekDetail): Promise<WeekDetail> {
  if (week === null) return { state: "none" };
  return guarded(g, laneId, "week detail", (c) => load(c, laneId, week));
}

// ---------------------------------------------------------------------------------------------------------- wording

export const CHECK_REASON_TEXT: Record<Extract<ArCheck, { kind: "missing" }>["reason"], string> = {
  not_cached: "The aging report is not cached yet. QuickBooks reports are fetched nightly.",
  withheld: "QuickBooks' total is withheld: the report leaves out people excluded by the payroll settings, so its total would be incomplete.",
  older_than_data: "The cached aging report is older than the latest data, so the two are not compared.",
  unreadable: "The cached aging report could not be read.",
};
export const CREDITS_NOTE = "Credit memos and unapplied credits are not synced, so a difference is expected for customers who hold credits. QuickBooks' report covers the whole company.";
export const WEEKLY_NOT_INCLUDED = "Not included: sales receipts, credit memos and refunds are not synced. Payroll is excluded.";
export const BUCKET_RULE = "Buckets count days past the due date (the invoice date when there is no due date) as of today in New York. Current means not yet due or due today.";
