// Home finance cards (T-233): cash (book balance), AR over 30 days and P&L month to date from `core.home_finance`, the
// read-only SQL function over fin.* (SECURITY INVOKER: RLS applies, AAL2 + the finance view). Every figure is computed in
// SQL (rule 7); this file only maps the row, formats money and dates, and chooses the words for an empty state. It never
// adds, subtracts or estimates anything, and never shows a sample number.
import type { Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";

const BUSINESS_TZ = "America/New_York";

export type FinanceState = "not_connected" | "no_data" | "mapping_missing" | "ok" | "no_access";

export type CashAccount = { name: string; bookBalance: number | null; shared: boolean };

export type HomeFinanceView =
  | { state: "unavailable" }
  | { state: "no_access" }
  | {
      state: Exclude<FinanceState, "no_access">;
      asOf: string | null;
      lastSyncAt: string | null;
      /** core.connections.status of the QuickBooks connection (reconnect_required, degraded...), or null. */
      connectionStatus: string | null;
      cash: { reason: string | null; total: number | null; asOf: string | null; accounts: CashAccount[]; unmapped: number };
      ar: { reason: string | null; over30: number | null; invoices: number; unmapped: number };
      pnl: { reason: string | null; income: number | null; expenses: number | null; net: number | null; start: string | null; end: string | null; method: string | null; partial: boolean; asOf: string | null };
    };

const STATES: readonly string[] = ["not_connected", "no_data", "mapping_missing", "ok", "no_access"];

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const count = (v: unknown): number => {
  const n = num(v);
  return n !== null && n >= 0 ? Math.floor(n) : 0;
};
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const instant = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

function toAccounts(v: unknown): CashAccount[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a: unknown) => {
    if (typeof a !== "object" || a === null) return [];
    const r = a as Record<string, unknown>;
    const name = text(r.name);
    return name ? [{ name, bookBalance: num(r.book_balance), shared: r.shared === true }] : [];
  });
}

/** The one row of core.home_finance as the page uses it. Unknown states fail closed to no_access (nothing shown). */
export function toHomeFinance(data: unknown): HomeFinanceView {
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row || typeof row.state !== "string" || !STATES.includes(row.state)) return { state: "no_access" };
  if (row.state === "no_access") return { state: "no_access" };
  return {
    state: row.state as Exclude<FinanceState, "no_access">,
    asOf: instant(row.as_of),
    lastSyncAt: instant(row.last_sync_at),
    connectionStatus: text(row.connection_status),
    cash: { reason: text(row.cash_reason), total: num(row.cash_total), asOf: instant(row.cash_as_of), accounts: toAccounts(row.cash_accounts), unmapped: count(row.cash_unmapped) },
    ar: { reason: text(row.ar_reason), over30: num(row.ar_over_30), invoices: count(row.ar_invoices), unmapped: count(row.ar_unmapped) },
    pnl: {
      reason: text(row.pnl_reason),
      income: num(row.pnl_income),
      expenses: num(row.pnl_expenses),
      net: num(row.pnl_net),
      start: text(row.pnl_start),
      end: text(row.pnl_end),
      method: text(row.pnl_method),
      partial: row.pnl_partial === true,
      asOf: instant(row.pnl_as_of),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------- formatting

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "$1,234.56" / "-$20.00": formatting only. */
export const formatMoney = (n: number): string => MONEY.format(n);

const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: BUSINESS_TZ });
/** "Nov 11, 3:00 PM ET". */
export const formatAsOf = (iso: string): string => `${WHEN.format(new Date(iso))} ET`;

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
/** "November 2026" for a YYYY-MM-DD date string (no time zone shift: it is a calendar date). */
export const formatMonth = (ymd: string): string => MONTH.format(new Date(`${ymd}T00:00:00Z`));

// ---------------------------------------------------------------------------------------------------------- cards

export const CONNECT_TEXT = "Connect QuickBooks in Settings";

export type FinanceCardKey = "cash" | "ar30" | "pnl";
export type FinanceCard = {
  key: FinanceCardKey;
  label: string;
  qualifier?: string;
  bookBalance?: boolean;
  /** Pre-formatted figure; present only when SQL returned one. */
  value?: string;
  /** Shown instead of a figure. */
  statusText?: string;
  /** "As of ..." line for the figure, or null. */
  asOf: string | null;
  /** Show the link to Settings -> Connections. */
  connectLink: boolean;
  /** Small lines under the figure. */
  details: string[];
  accounts: { name: string; value: string; shared: boolean }[];
};

const CASH_REASONS: Record<string, string> = {
  balance_sheet_not_cached: "The balance sheet is not part of the QuickBooks sync yet",
  balance_sheet_class_filtered: "The balance sheet report is filtered by class, so it is not a book balance",
  report_has_columns: "The balance sheet report could not be read",
  balance_unreadable: "A bank account balance could not be read",
  bank_mapping_missing: "Bank accounts are not mapped to this company yet",
  no_own_bank_accounts: "No bank account in the report is mapped to this company",
};
const AR_REASONS: Record<string, string> = { no_invoices: "No invoices synced yet" };
const PNL_REASONS: Record<string, string> = {
  month_report_not_cached: "The month-to-date report is not synced yet",
  report_not_split_by_class: "The report is not split by class yet",
  report_has_columns: "The report could not be read",
  figure_unreadable: "The report could not be read",
  report_empty: "No income or expense lines yet this month",
};

const reasonText = (map: Record<string, string>, reason: string): string => map[reason] ?? "Not available yet";

/** The wording of a whole-section empty state, or null when the figures themselves are shown. */
export function emptyStateText(view: Exclude<HomeFinanceView, { state: "no_access" }>): string | null {
  switch (view.state) {
    case "unavailable":
      return "Could not load QuickBooks figures. Reload in a minute.";
    case "not_connected":
      return CONNECT_TEXT;
    case "no_data":
      return `No QuickBooks data yet (${view.lastSyncAt ? `last sync ${formatAsOf(view.lastSyncAt)}` : "not synced yet"})`;
    case "mapping_missing":
      return "QuickBooks is connected, but this company's entity mapping is missing. Ask your administrator to set it up.";
    case "ok":
      return null;
  }
}

/** The three cards for a view. [] for a role that may not see finance. */
export function financeCards(view: HomeFinanceView): FinanceCard[] {
  if (view.state === "no_access") return [];
  const base = (key: FinanceCardKey, label: string, extra: Partial<FinanceCard> = {}): FinanceCard => ({ key, label, asOf: null, connectLink: false, details: [], accounts: [], ...extra });
  const empty = emptyStateText(view);
  if (empty !== null) {
    const link = view.state === "not_connected";
    return [
      base("cash", "Cash", { bookBalance: true, statusText: empty, connectLink: link }),
      base("ar30", "AR > 30 days", { statusText: empty, connectLink: link }),
      base("pnl", "P&L month to date", { statusText: empty, connectLink: link }),
    ];
  }
  if (view.state !== "ok") return [];

  const asOfFor = (iso: string | null) => {
    const at = iso ?? view.asOf;
    return at ? `As of ${formatAsOf(at)}` : null;
  };

  const c = view.cash;
  const cash =
    c.reason === null && c.total !== null
      ? base("cash", "Cash", {
          bookBalance: true,
          value: formatMoney(c.total),
          asOf: asOfFor(c.asOf),
          accounts: c.accounts.flatMap((a) => (a.bookBalance === null ? [] : [{ name: a.name, value: formatMoney(a.bookBalance), shared: a.shared }])),
          details: c.unmapped > 0 ? [`${String(c.unmapped)} bank ${c.unmapped === 1 ? "account is" : "accounts are"} not mapped to a company and not included`] : [],
        })
      : base("cash", "Cash", { bookBalance: true, statusText: reasonText(CASH_REASONS, c.reason ?? "") });

  const a = view.ar;
  const ar =
    a.reason === null && a.over30 !== null
      ? base("ar30", "AR > 30 days", {
          value: formatMoney(a.over30),
          asOf: asOfFor(view.asOf),
          qualifier: "more than 30 days past due",
          details: [
            `${String(a.invoices)} open ${a.invoices === 1 ? "invoice" : "invoices"}`,
            ...(a.unmapped > 0 ? [`${String(a.unmapped)} overdue ${a.unmapped === 1 ? "invoice has" : "invoices have"} no company and ${a.unmapped === 1 ? "is" : "are"} not included`] : []),
          ],
        })
      : base("ar30", "AR > 30 days", { statusText: reasonText(AR_REASONS, a.reason ?? "") });

  const p = view.pnl;
  const pnl =
    p.reason === null && p.net !== null && p.income !== null && p.expenses !== null
      ? base("pnl", "P&L month to date", {
          qualifier: `Net, ${p.start ? formatMonth(p.start) : "this month"}`,
          value: formatMoney(p.net),
          asOf: asOfFor(p.asOf),
          details: [
            `Income ${formatMoney(p.income)} · Expenses ${formatMoney(p.expenses)}`,
            ...(p.method ? [`${p.method === "cash" ? "Cash" : "Accrual"} basis`] : []),
            ...(p.partial ? ["Excludes payroll accounts"] : []),
          ],
        })
      : base("pnl", "P&L month to date", { statusText: reasonText(PNL_REASONS, p.reason ?? "") });

  return [cash, ar, pnl];
}

/** A line telling the user a connection needs attention, for the section note. */
export function connectionNote(view: HomeFinanceView): string | null {
  if (view.state === "no_access" || view.state === "unavailable") return null;
  if (view.connectionStatus === "reconnect_required") return "QuickBooks needs reconnecting. These figures may be out of date.";
  if (view.connectionStatus === "degraded") return "The QuickBooks connection has problems. These figures may be out of date.";
  return null;
}

// ---------------------------------------------------------------------------------------------------------- loading

type Db = Pick<LaneClient, "schema">;

/** Reads core.home_finance for the lane. Throws on a database error. */
export async function loadHomeFinance(client: Db, laneId: string): Promise<HomeFinanceView> {
  const { data, error } = await client.schema("core").rpc("home_finance", { p_lane: laneId });
  if (error) throw new Error("finance unavailable");
  return toHomeFinance(data);
}

/** The lane gate has already run on the page; an outage gives `unavailable`, never an empty or invented figure. */
export async function homeFinanceFor(g: Pick<Guards, "requireLane">, laneId: string, load = loadHomeFinance): Promise<HomeFinanceView> {
  try {
    const { client } = await g.requireLane(laneId as Parameters<Guards["requireLane"]>[0]);
    return await load(client, laneId);
  } catch (e) {
    console.error("[home] finance unavailable", { laneId, reason: e instanceof Error ? e.name : typeof e });
    return { state: "unavailable" };
  }
}
