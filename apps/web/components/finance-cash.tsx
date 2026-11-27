// Finance > Cash (T-302, spec finance.md 15.4): the book balance of each bank account today and at the end (Friday, New York) of each
// completed business week, the change from the next older column, and a total row. Every figure, change and total is computed in SQL
// (core.finance_cash); this file formats and chooses words. A balance that was not read is said so ("Not read yet"), never shown as 0,
// and a total is never a partial sum. Money in and out is not shown (spec 15.4).
import type { CSSProperties } from "react";
import { cache } from "react";
import { PageSection } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { loadLane } from "@/lib/lane-page";
import { timed } from "@/lib/timed";
import { formatAsOf, formatMoney, hasFinanceView } from "@/lib/home-finance";
import { formatDay } from "@/lib/finance-page";
import { CASH_NOTE, CASH_REASON_TEXT, financeCashFor, type CashCell, type CashColumn, type FinanceCash, type FinanceCashData } from "@/lib/finance-reports";
import { CardBoundary } from "./card-boundary";
import { ReportFrame, Small, UNAVAILABLE, plural } from "./finance-report-frame";

// The columns are dynamic (today and up to 13 week ends): a CSS variable carries the count. On a phone each account is a stack (label beside figure).
const GRID = "md:grid md:grid-cols-[minmax(11rem,1.6fr)_repeat(var(--cash-cols),minmax(8rem,1fr))] md:items-start md:gap-x-3";
const CELL = "flex items-baseline justify-between gap-3 tabular-nums md:flex-col md:items-end md:gap-0 md:text-right";
const LABEL = "text-small text-muted-foreground md:hidden";

/** "+$100.50", "-$20.00", "No change": the sign is the SQL difference's, never recomputed. */
export const formatChange = (n: number): string => (n === 0 ? "No change" : n > 0 ? `+${formatMoney(n)}` : formatMoney(n));

const columnLabel = (c: CashColumn): string => (c.kind === "today" ? "Today" : `Fri ${formatDay(c.date)}`);
const columnSub = (c: CashColumn): string => {
  if (c.kind === "today") return c.asOf ? `Books synced ${formatAsOf(c.asOf)}` : "Not synced yet";
  return c.read === 0 || c.asOf === null ? "Not read yet" : `Read ${formatAsOf(c.asOf)}`;
};

function Cell({ cell, column, total }: { cell: CashCell; column: CashColumn; total?: { missing: number } }) {
  const notRead = column.kind === "week_end" && column.read === 0;
  const missingText = total ? "Not complete" : column.kind === "today" ? "No balance yet" : notRead ? "Not read yet" : "Not available";
  return (
    <span role="cell" data-column={column.date} className={CELL}>
      <span className={LABEL}>{columnLabel(column)}</span>
      <span className="flex flex-col md:items-end">
        {cell.bookBalance === null ? (
          <span data-field="book-balance" data-missing="true" className="text-muted-foreground">{missingText}</span>
        ) : (
          <span data-field="book-balance" className="font-semibold text-foreground">{formatMoney(cell.bookBalance)}</span>
        )}
        {total && cell.bookBalance === null && total.missing > 0 ? (
          <span data-field="missing" className="text-small text-muted-foreground">{`${plural(total.missing, "account has", "accounts have")} no balance`}</span>
        ) : null}
        {cell.change !== null ? <span data-field="change" className="text-small text-muted-foreground">{`${formatChange(cell.change)} vs. the older column`}</span> : null}
      </span>
    </span>
  );
}

function CashBody({ cash }: { cash: FinanceCashData }) {
  const note = `${cash.businessDate ? `As of ${formatDay(cash.businessDate)} · ` : ""}Weeks run Saturday to Friday (New York)`;
  if (cash.reason !== null) return <PageSection title="Cash: book balance by account" note={note} emptyTitle={CASH_REASON_TEXT[cash.reason]} />;
  if (cash.columns.length === 0 || cash.accounts.length === 0) return <PageSection title="Cash: book balance by account" note={note} emptyTitle="Not available yet" />;
  const style = { "--cash-cols": String(cash.columns.length) } as CSSProperties;
  const weekColumns = cash.columns.filter((c) => c.kind === "week_end");
  const unread = weekColumns.filter((c) => c.read === 0).length;
  const total = cash.totals;
  return (
    <PageSection title="Cash: book balance by account" note={note}>
      <Small>{`Today and the end of the last ${plural(weekColumns.length, "completed week", "completed weeks")}, newest first. Each figure is a book balance with its change from the older column next to it.`}</Small>
      <div className="md:overflow-x-auto">
        <div data-testid="finance-cash-table" role="table" aria-label="Book balance by bank account, today and at the end of each week" style={style} className="flex flex-col md:min-w-max">
          <div role="row" className={`hidden border-b border-border pb-2 text-label text-muted-foreground ${GRID}`}>
            <span role="columnheader">Bank account</span>
            {cash.columns.map((c) => (
              <span key={c.date + c.kind} role="columnheader" data-column={c.date} className="flex flex-col text-right">
                <span>{columnLabel(c)}</span>
                <span className="text-small font-normal">{columnSub(c)}</span>
              </span>
            ))}
          </div>
          <div role="rowgroup" className="flex flex-col divide-y divide-border">
            {cash.accounts.map((a, i) => (
              <div key={`${a.name}-${String(i)}`} role="row" data-testid="finance-cash-account-row" className={`flex flex-col gap-1 py-3 text-body ${GRID}`}>
                <span role="rowheader" data-field="account" className="flex min-w-0 flex-wrap items-center gap-2 text-foreground">
                  <span className="truncate font-medium">{a.name}</span>
                  {a.shared ? <span className="rounded-control border border-border px-2 text-label text-muted-foreground">Shared account</span> : null}
                </span>
                {a.cells.map((cell, k) => <Cell key={cash.columns[k]?.date ?? String(k)} cell={cell} column={cash.columns[k] as CashColumn} />)}
              </div>
            ))}
            {total.length === cash.columns.length ? (
              <div role="row" data-testid="finance-cash-total-row" className={`flex flex-col gap-1 py-3 text-body ${GRID}`}>
                <span role="rowheader" data-field="account" className="font-semibold text-foreground">Total book balance</span>
                {total.map((t, k) => <Cell key={cash.columns[k]?.date ?? String(k)} cell={t} column={cash.columns[k] as CashColumn} total={t} />)}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {unread > 0 ? <Small testId="finance-cash-unread">{`${plural(unread, "week end has", "week ends have")} not been read from QuickBooks yet. QuickBooks is read nightly; a week end that cannot be read stays blank.`}</Small> : null}
      {total.length === 0 ? <Small testId="finance-cash-no-total">{`${plural(cash.unreadableAccounts, "account row", "account rows")} could not be read, so no total is shown.`}</Small> : null}
      <Small>A total is shown only when every account of the column has a balance; it is never a partial sum.</Small>
      <Small testId="finance-cash-note">{CASH_NOTE}</Small>
    </PageSection>
  );
}

export function CashView({ laneId, laneName, data }: { laneId: string; laneName: string; data: FinanceCash }) {
  const status = data.state === "unavailable" || data.state === "no_access" ? { state: data.state } : { state: data.state, lastSyncAt: data.lastSyncAt, connectionStatus: data.connectionStatus };
  return (
    <ReportFrame laneId={laneId} laneName={laneName} accent="cash" active="cash" title="Cash: book balance by account" status={status}>
      {data.state === "ok" ? (
        <CardBoundary label="Cash by account and week" kind="section">
          <CashBody cash={data} />
        </CardBoundary>
      ) : (
        <PageSection title="Cash: book balance by account" emptyTitle={UNAVAILABLE} />
      )}
    </ReportFrame>
  );
}

async function loadData(laneId: string): Promise<FinanceCash> {
  const g = await guards();
  const cash = await timed("load.finance.cash", async () => financeCashFor(g, laneId));
  // An outage is shown only to a caller who holds the lane's finance view; anyone else sees no figures.
  if (cash.state === "unavailable" && !(await hasFinanceView(g, laneId))) return { state: "no_access" };
  return cash;
}

/** The page's read, once per request (React cache), started beside the module gate (T-276). */
const cashData = cache((laneId: string) => loadData(laneId));

export function startCash(params: Promise<{ laneId: string }>): void {
  void params.then((p) => cashData(p.laneId)).catch(() => undefined);
}

export async function CashPage({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const data = await cashData(lane.laneId);
  return <CashView laneId={lane.laneId} laneName={lane.name} data={data} />;
}
