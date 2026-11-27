// QuickBooks bank balances from the Balance Sheet (T-302, spec finance.md 15.4): the book balance of each of the lane's bank accounts at the end of a date.
//
// What is read and what is kept (rules 4, 6, 7, 13; D-25 and D-27 unchanged):
//  - ONE report request per date: GET /v3/company/{realm}/reports/BalanceSheet with start_date = end_date = the date and accounting_method (the lane's
//    method; a bank account's balance is the same in both). No class filter: a bank balance is the whole account (D-18). One value column (no
//    summarize_column_by), so a row is { account cell, amount cell }. UNVERIFIED against Intuit: only the synthetic MSW fake exists (H-035 / T-302 live
//    check): that the balance is "as of end_date" for a one-day range, and that the amount is the second cell.
//  - The raw report is cut down HERE, before anything leaves this function: `projectBankBalances` returns only { accountId, balance } for ids in the set
//    passed in (the lane's bank accounts that the normalizer kept, minus payroll accounts). No label, section, total, other account, header or
//    column of the report is returned, stored, logged, cached or put in an error message (all messages are constants). `balance_sheet` is NOT a cached
//    report kind (D-27): nothing of a Balance Sheet reaches fin.report_cache.
//  - A row is an account's OWN balance only when ALL of this holds, otherwise the account is left out of the answer (the cell then reads "not read yet";
//    never a possibly wrong figure):
//      1. the row is a leaf row (type "Data") whose FIRST cell carries the account id (matched on the id only, never on a label); a row without an id
//         is dropped;
//      2. the row has exactly two cells and the second is a plain figure (digits, one sign, one decimal point; no text);
//      3. that id appears on NO other row or cell anywhere in the report: not on a second Data row, and not on a section Header or Summary row. A parent
//         account's section header and "Total <parent>" summary carry the parent's id and include its sub-accounts, so a parent with sub-accounts is
//         not read at all (nothing is guessed about which row is "own");
//  - Bounds: at most MAX_ROWS rows and MAX_LEVEL levels of nesting, at most MAX_IDS ids asked for; beyond that the report is refused (fail closed).
//  - A report for another date, another accounting basis or another currency than asked is refused (the figures would be mislabelled).
import { z } from "zod";
import { ConnectorError } from "../contract/errors";
import { businessDate, businessWeekStart } from "./reports";

const MAX_LEVEL = 10;
const MAX_ROWS = 20_000;
const MAX_COLUMNS = 64;
export const MAX_BANK_IDS = 200;

const FIGURE = /^-?[0-9]{1,15}(\.[0-9]{1,6})?$/;
const SAFE_ID = /^[0-9]{1,20}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:?[0-9]{2})$/;

const two = (v: number) => String(v).padStart(2, "0");

/**
 * The Fridays that end the `weeks` most recently COMPLETED business weeks (Saturday to Friday, America/New_York, rule 11), newest first, as YYYY-MM-DD.
 * On a Friday the current week is not complete (its Friday is today): the first date is the Friday before. On a Saturday it is yesterday.
 * Pure calendar arithmetic on the New York date (UTC fields of a UTC midnight): a year end or a DST change cannot move a date. The database computes the
 * same dates (core.finance_cash).
 */
export function cashHistoryDates(nowMs: number, weeks: number): string[] {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 13) throw new ConnectorError({ kind: "invalid_input", message: "The number of weeks is not valid" });
  const today = businessDate(nowMs);
  const start = businessWeekStart(today); // the Saturday that starts the current week
  const [y, m, d] = start.split("-").map(Number) as [number, number, number];
  const out: string[] = [];
  for (let n = 1; n <= weeks; n += 1) {
    const f = new Date(Date.UTC(y, m - 1, d) - ((n - 1) * 7 + 1) * 86_400_000);
    out.push(`${String(f.getUTCFullYear())}-${two(f.getUTCMonth() + 1)}-${two(f.getUTCDate())}`);
  }
  return out;
}

export type BalanceSheetRequest = { path: string; query: Record<string, string>; date: string; method: "accrual" | "cash" };

/** The request for the Balance Sheet at the end of one date. Pure. */
export function planBalanceSheetAt(date: string, method: "accrual" | "cash"): BalanceSheetRequest {
  if (!DATE.test(date)) throw new ConnectorError({ kind: "invalid_input", message: "The balance date is not valid" });
  return {
    path: "/v3/company/{realm}/reports/BalanceSheet",
    query: { start_date: date, end_date: date, accounting_method: method === "cash" ? "Cash" : "Accrual" },
    date,
    method,
  };
}

const Cell = z.object({ value: z.string().max(512).optional(), id: z.string().max(64).optional() });
const RowNode = z.object({
  type: z.string().max(32).optional(),
  Header: z.object({ ColData: z.array(Cell).max(MAX_COLUMNS) }).optional(),
  Summary: z.object({ ColData: z.array(Cell).max(MAX_COLUMNS) }).optional(),
  ColData: z.array(Cell).max(MAX_COLUMNS).optional(),
  Rows: z.object({ Row: z.array(z.unknown()).max(MAX_ROWS) }).optional(),
});
const ReportIn = z.object({
  Header: z.object({
    Time: z.string().max(64).optional(),
    ReportBasis: z.string().max(16).optional(),
    EndPeriod: z.string().max(16).optional(),
    Currency: z.string().max(8).optional(),
  }),
  Rows: z.object({ Row: z.array(z.unknown()).max(MAX_ROWS).optional() }).optional(),
});

export type BankBalance = { accountId: string; balance: string };
export type ProjectedBankBalances = {
  /** Only the accounts whose own balance could be told apart safely; ordered by account id. */
  balances: BankBalance[];
  /** The instant Intuit produced the report (Header.Time), or null when absent or unreadable. */
  producedAt: string | null;
};

const bad = (message: string, tid: string | null) => new ConnectorError({ kind: "provider_error", message, provider_tid: tid });

/**
 * Cuts a Balance Sheet answer down to { accountId, balance } for the ids in `accountIds` (see the file header for the rules). Throws a provider_error
 * with a constant message on any shape problem; nothing of the answer is in it.
 */
export function projectBankBalances(request: BalanceSheetRequest, raw: unknown, accountIds: ReadonlySet<string>, tid: string | null = null): ProjectedBankBalances {
  if (accountIds.size > MAX_BANK_IDS) throw bad("Too many bank accounts to read", tid);
  const parsed = ReportIn.safeParse(raw);
  if (!parsed.success) throw bad("Balance sheet response is not valid", tid);
  const { Header: h, Rows: r } = parsed.data;
  if (h.EndPeriod !== undefined && h.EndPeriod !== request.date) throw bad("Balance sheet is not for the requested date", tid);
  if (h.ReportBasis !== undefined && h.ReportBasis.toLowerCase() !== request.method) throw bad("Balance sheet basis differs from the request", tid);
  if (h.Currency !== undefined && h.Currency !== "USD") throw bad("Balance sheet currency is not supported", tid);
  const producedAt = h.Time !== undefined && INSTANT.test(h.Time) && !Number.isNaN(Date.parse(h.Time)) ? new Date(h.Time).toISOString() : null;

  // Per wanted id: how many cells of the report carry it, and the candidate figure of a leaf row.
  const seen = new Map<string, number>();
  const candidate = new Map<string, string>();
  let rows = 0;
  const mark = (cells: readonly { value?: string | undefined; id?: string | undefined }[]) => {
    for (const cell of cells) if (cell.id !== undefined && accountIds.has(cell.id)) seen.set(cell.id, (seen.get(cell.id) ?? 0) + 1);
  };
  const walk = (list: readonly unknown[], level: number): void => {
    if (level > MAX_LEVEL) throw bad("Balance sheet is nested too deeply", tid);
    for (const item of list) {
      rows += 1;
      if (rows > MAX_ROWS) throw bad("Balance sheet has too many rows", tid);
      const p = RowNode.safeParse(item);
      if (!p.success) throw bad("A balance sheet row does not match the expected shape", tid);
      const node = p.data;
      if (node.Header) mark(node.Header.ColData);
      if (node.Summary) mark(node.Summary.ColData);
      if (node.ColData) {
        mark(node.ColData);
        const [first, second, ...rest] = node.ColData;
        const id = first?.id;
        if (node.type === "Data" && id !== undefined && SAFE_ID.test(id) && accountIds.has(id) && second !== undefined && rest.length === 0 && second.value !== undefined && FIGURE.test(second.value)) {
          candidate.set(id, second.value);
        }
      }
      if (node.Rows) walk(node.Rows.Row, level + 1);
    }
  };
  walk(r?.Row ?? [], 0);

  const balances: BankBalance[] = [];
  for (const id of [...candidate.keys()].sort()) {
    if (seen.get(id) === 1) balances.push({ accountId: id, balance: candidate.get(id) as string });
  }
  return { balances, producedAt };
}
