// Finance > Invoices & payments (T-301, spec finance.md 15.3): invoices issued and payments received per business week (Saturday to
// Friday, New York). Every figure and every week boundary is computed in SQL (core.finance_weekly, core.finance_week_detail); this file
// formats and chooses words. Choosing a week is a link (`?week=YYYY-MM-DD`): the page renders per request on the server.
import Link from "next/link";
import { cache } from "react";
import { PageSection, laneHref } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { loadLane } from "@/lib/lane-page";
import { timed } from "@/lib/timed";
import { formatAsOf, formatMoney, hasFinanceView } from "@/lib/home-finance";
import { formatDay, formatRange } from "@/lib/finance-page";
import { PAYMENT_AMOUNT_NOTE, WEEKLY_NOT_INCLUDED, financeWeeklyFor, parseWeek, weekDetailFor, type FinanceWeekly, type FinanceWeeklyData, type WeekDetail, type WeekRow } from "@/lib/finance-reports";
import { CardBoundary } from "./card-boundary";
import { ReportFrame, Small, UNAVAILABLE, plural } from "./finance-report-frame";
import { WeeklyChart } from "./finance-weekly-chart";

const UNKNOWN = "Unknown customer";
const GRID = "md:grid md:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] md:items-baseline md:gap-x-3";
const CELL = "flex items-baseline justify-between gap-3 tabular-nums md:block md:text-right";
const LABEL = "text-small text-muted-foreground md:hidden";

export type WeeklyData = { weekly: FinanceWeekly; detail: WeekDetail; week: string | null };

const weekHref = (laneId: string, start: string | null) => (start === null ? laneHref(laneId, "finance/weekly") : `${laneHref(laneId, "finance/weekly")}?week=${start}`);

function WeekRowView({ laneId, w, selected }: { laneId: string; w: WeekRow; selected: boolean }) {
  return (
    <div role="row" data-testid="finance-week-row" data-week={w.start} data-current={w.isCurrent ? "true" : "false"} className={`flex flex-col gap-1 py-3 text-body ${GRID} ${selected ? "bg-accent/40" : ""}`}>
      <span role="rowheader" data-field="week" className="flex min-w-0 flex-col">
        <Link href={weekHref(laneId, selected ? null : w.start)} aria-current={selected ? "true" : undefined} className="font-medium text-foreground underline-offset-2 hover:underline">
          {formatRange(w.start, w.end)}
        </Link>
        {w.isCurrent ? <span className="text-small text-muted-foreground">{`This week, to ${formatDay(w.through)}`}</span> : null}
      </span>
      <span role="cell" data-field="invoiced-count" className={CELL}><span className={LABEL}>Invoices issued</span><span>{String(w.invoicedCount)}</span></span>
      <span role="cell" data-field="invoiced-amount" className={`${CELL} font-medium text-foreground`}><span className={LABEL}>Invoiced</span><span>{formatMoney(w.invoicedAmount)}</span></span>
      <span role="cell" data-field="received-count" className={CELL}><span className={LABEL}>Payments received</span><span>{String(w.receivedCount)}</span></span>
      <span role="cell" data-field="received-amount" className={`${CELL} font-medium text-foreground`}><span className={LABEL}>Received</span><span>{formatMoney(w.receivedAmount)}</span></span>
    </div>
  );
}

function WeekDetailView({ detail }: { detail: Extract<WeekDetail, { state: "ok" }> }) {
  const cap = (shown: number, total: number, what: string) =>
    total > shown ? <Small testId="finance-week-cap">{`Showing the first ${String(shown)} of ${String(total)} ${what} (at most ${String(detail.rowCap)} are listed). The week's figures above count all of them.`}</Small> : null;
  return (
    <PageSection title={`Week of ${formatRange(detail.start, detail.end)}`} note="Invoices by invoice date · payments by payment date" ariaLabel="Chosen week">
      <div data-testid="finance-week-detail" className="grid gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="font-heading text-body font-semibold text-foreground">Invoices issued</h3>
          {detail.invoices.length === 0 ? (
            <Small testId="finance-week-invoices-empty">No invoices issued this week.</Small>
          ) : (
            <div data-testid="finance-week-invoices" role="table" aria-label="Invoices issued" className="flex flex-col divide-y divide-border">
              <div role="row" className="hidden grid-cols-[minmax(0,2fr)_1fr_1fr_1fr] gap-3 pb-1 text-label text-muted-foreground md:grid">
                <span role="columnheader">Customer</span><span role="columnheader">Date</span><span role="columnheader" className="text-right">Total</span><span role="columnheader" className="text-right">Open balance</span>
              </div>
              {detail.invoices.map((i, k) => (
                <div key={`${i.date ?? "x"}-${String(k)}`} role="row" data-testid="finance-week-invoice" className="grid grid-cols-2 gap-x-3 gap-y-1 py-2 text-small md:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr]">
                  <span role="rowheader" className="min-w-0 truncate font-medium text-foreground">{i.customer ?? UNKNOWN}</span>
                  <span role="cell">{i.date ? formatDay(i.date) : "Not recorded"}</span>
                  <span role="cell" className="tabular-nums md:text-right"><span className="text-muted-foreground md:hidden">Total </span>{formatMoney(i.total)}</span>
                  <span role="cell" className="tabular-nums md:text-right"><span className="text-muted-foreground md:hidden">Open </span>{formatMoney(i.openBalance)}</span>
                </div>
              ))}
            </div>
          )}
          {cap(detail.invoices.length, detail.invoiceCount, "invoices")}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="font-heading text-body font-semibold text-foreground">Payments received</h3>
          {detail.payments.length === 0 ? (
            <Small testId="finance-week-payments-empty">No payments received this week.</Small>
          ) : (
            <div data-testid="finance-week-payments" role="table" aria-label="Payments received" className="flex flex-col divide-y divide-border">
              <div role="row" className="hidden grid-cols-[minmax(0,2fr)_1fr_1fr] gap-3 pb-1 text-label text-muted-foreground md:grid">
                <span role="columnheader">Customer</span><span role="columnheader">Date</span><span role="columnheader" className="text-right">Amount</span>
              </div>
              {detail.payments.map((p, k) => (
                <div key={`${p.date ?? "x"}-${String(k)}`} role="row" data-testid="finance-week-payment" className="grid grid-cols-2 gap-x-3 gap-y-1 py-2 text-small md:grid-cols-[minmax(0,2fr)_1fr_1fr]">
                  <span role="rowheader" className="min-w-0 truncate font-medium text-foreground">{p.customer ?? UNKNOWN}</span>
                  <span role="cell">{p.date ? formatDay(p.date) : "Not recorded"}</span>
                  <span role="cell" className="tabular-nums md:text-right">{formatMoney(p.amount)}</span>
                </div>
              ))}
            </div>
          )}
          {cap(detail.payments.length, detail.paymentCount, "payments")}
          <Small>A payment is listed once. Its amount is what was applied to invoices plus any unapplied remainder, as stored.</Small>
        </div>
      </div>
    </PageSection>
  );
}

function WeeklyBody({ laneId, weekly, detail, week }: { laneId: string; weekly: FinanceWeeklyData; detail: WeekDetail; week: string | null }) {
  const note = `${weekly.businessDate ? `As of ${formatDay(weekly.businessDate)} · ` : ""}Weeks run Saturday to Friday (New York)${weekly.asOf ? ` · data from ${formatAsOf(weekly.asOf)}` : ""}`;
  if (weekly.weeks.length === 0) return <PageSection title="Invoices and payments by week" note={note} emptyTitle="Not available yet" />;
  const completed = weekly.weeks.filter((w) => !w.isCurrent).length;
  // Oldest week on the left of the chart; only the order changes, the figures are SQL's.
  const points = [...weekly.weeks].reverse().map((w) => ({ label: formatDay(w.start).replace(/, \d{4}$/, ""), invoiced: w.invoicedAmount, received: w.receivedAmount }));
  const selected = detail.state === "ok" ? week : null;
  return (
    <>
      <PageSection title="Invoices and payments by week" note={note}>
        <Small>{`The current week to date and the ${plural(completed, "completed week", "completed weeks")} before it. Invoices count by invoice date; payments by the date of the payment in QuickBooks.`}</Small>
        <WeeklyChart points={points} />
        <div data-testid="finance-weekly-table" role="table" aria-label="Invoices and payments by week" className="flex flex-col">
          <div role="row" className={`hidden border-b border-border pb-2 text-label text-muted-foreground ${GRID}`}>
            <span role="columnheader">Week (Sat–Fri)</span><span role="columnheader" className="text-right">Invoices issued</span><span role="columnheader" className="text-right">Invoiced</span><span role="columnheader" className="text-right">Payments received</span><span role="columnheader" className="text-right">Received</span>
          </div>
          <div role="rowgroup" className="flex flex-col divide-y divide-border">
            {weekly.weeks.map((w) => <WeekRowView key={w.start} laneId={laneId} w={w} selected={selected === w.start} />)}
          </div>
        </div>
        <Small>Choose a week to list its invoices and payments.</Small>
        <Small testId="finance-weekly-not-included">{WEEKLY_NOT_INCLUDED}</Small>
        <Small testId="finance-weekly-payment-note">{PAYMENT_AMOUNT_NOTE}</Small>
      </PageSection>
      {detail.state === "ok" ? (
        <CardBoundary label="Chosen week" kind="section">
          <WeekDetailView detail={detail} />
        </CardBoundary>
      ) : detail.state === "unavailable" ? (
        <PageSection title="Chosen week" emptyTitle={UNAVAILABLE} />
      ) : null}
    </>
  );
}

export function WeeklyView({ laneId, laneName, data }: { laneId: string; laneName: string; data: WeeklyData }) {
  const { weekly } = data;
  const status = weekly.state === "unavailable" || weekly.state === "no_access" ? { state: weekly.state } : { state: weekly.state, lastSyncAt: weekly.lastSyncAt, connectionStatus: weekly.connectionStatus };
  return (
    <ReportFrame laneId={laneId} laneName={laneName} accent="invoices and payments" active="weekly" title="Invoices and payments by week" status={status}>
      {weekly.state === "ok" ? (
        <CardBoundary label="Invoices and payments by week" kind="section">
          <WeeklyBody laneId={laneId} weekly={weekly} detail={data.detail} week={data.week} />
        </CardBoundary>
      ) : (
        <PageSection title="Invoices and payments by week" emptyTitle={UNAVAILABLE} />
      )}
    </ReportFrame>
  );
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function loadData(laneId: string, week: string | null): Promise<WeeklyData> {
  const g = await guards();
  const [weekly, detail] = await Promise.all([
    timed("load.finance.weekly", async () => financeWeeklyFor(g, laneId)),
    timed("load.finance.week_detail", async () => weekDetailFor(g, laneId, week)),
  ]);
  // An outage is shown only to a caller who holds the lane's finance view; anyone else sees no figures.
  if ((weekly.state === "unavailable" || detail.state === "unavailable") && !(await hasFinanceView(g, laneId))) return { weekly: { state: "no_access" }, detail: { state: "none" }, week: null };
  return { weekly, detail, week };
}

/** The page's reads, once per request (React cache; key: lane and the searchParams promise), started beside the module gate (T-276). */
const weeklyData = cache(async (laneId: string, searchParams: SearchParams | undefined) => {
  const week = parseWeek(searchParams ? (await searchParams).week : undefined);
  return loadData(laneId, week);
});

export function startWeekly(params: Promise<{ laneId: string }>, searchParams: SearchParams | undefined): void {
  void params.then((p) => weeklyData(p.laneId, searchParams)).catch(() => undefined);
}

export async function WeeklyPage({ params, searchParams }: { params: Promise<{ laneId: string }>; searchParams?: SearchParams }) {
  const lane = await loadLane((await params).laneId);
  const data = await weeklyData(lane.laneId, searchParams);
  return <WeeklyView laneId={lane.laneId} laneName={lane.name} data={data} />;
}
