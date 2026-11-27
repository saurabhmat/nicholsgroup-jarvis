// Finance > Receivables (T-300, spec finance.md 15.2): aged AR by customer. Every figure is computed in SQL (core.finance_receivables);
// this file formats and chooses words. The open invoices are exactly the ones the Overview ages, so the totals equal the Overview's.
// A customer's open invoices open inside its row (a native <details>: no client state, no customer id in an address).
import { cache } from "react";
import { PageSection } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { loadLane } from "@/lib/lane-page";
import { timed } from "@/lib/timed";
import { formatAsOf, formatMoney, hasFinanceView } from "@/lib/home-finance";
import { AGING_BUCKETS, AGING_LABEL } from "@/lib/home-finance-detail";
import { formatDay } from "@/lib/finance-page";
import { BUCKET_RULE, CHECK_REASON_TEXT, CREDITS_NOTE, receivablesFor, type ArCheck, type ReceivableCustomer, type Receivables, type ReceivablesData } from "@/lib/finance-reports";
import { CardBoundary } from "./card-boundary";
import { ReportFrame, Small, UNAVAILABLE, plural } from "./finance-report-frame";

// Seven figure columns after the name on a wide screen; on a phone each row is a stack (label beside figure).
const GRID = "md:grid md:grid-cols-[minmax(0,2.2fr)_repeat(5,minmax(0,1fr))_minmax(0,1.1fr)_minmax(0,0.9fr)] md:items-baseline md:gap-x-3";
const CELL = "flex items-baseline justify-between gap-3 tabular-nums md:block md:text-right";
const LABEL = "text-small text-muted-foreground md:hidden";
const UNKNOWN = "Unknown customer";

function Figures({ buckets, total, invoices }: { buckets: Record<(typeof AGING_BUCKETS)[number], number>; total: number; invoices: number }) {
  return (
    <>
      {AGING_BUCKETS.map((b) => (
        <span key={b} data-bucket={b} className={CELL}>
          <span className={LABEL}>{AGING_LABEL[b]}</span>
          <span>{formatMoney(buckets[b])}</span>
        </span>
      ))}
      <span data-field="total" className={`${CELL} font-semibold text-foreground`}>
        <span className={LABEL}>Total</span>
        <span>{formatMoney(total)}</span>
      </span>
      <span data-field="invoices" className={CELL}>
        <span className={LABEL}>Open invoices</span>
        <span>{String(invoices)}</span>
      </span>
    </>
  );
}

function CustomerRow({ c }: { c: ReceivableCustomer }) {
  return (
    <li data-testid="finance-ar-row">
      <details className="group">
        <summary className={`cursor-pointer list-none py-3 text-body marker:hidden [&::-webkit-details-marker]:hidden ${GRID} flex flex-col gap-1`}>
          <span data-field="customer" className="flex items-center gap-2 font-medium text-foreground">
            <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
            <span className="min-w-0 truncate">{c.name ?? UNKNOWN}</span>
          </span>
          <Figures buckets={c.buckets} total={c.total} invoices={c.invoices} />
        </summary>
        <div data-testid="finance-ar-detail" className="mb-3 ml-5 flex flex-col gap-2 rounded-control bg-muted/40 p-3">
          <ul className="flex flex-col divide-y divide-border">
            <li aria-hidden className="hidden grid-cols-4 gap-3 pb-1 text-label text-muted-foreground md:grid">
              <span>Invoice date</span><span>Due date</span><span className="text-right">Days overdue</span><span className="text-right">Balance</span>
            </li>
            {c.detail.map((d, i) => (
              <li key={`${d.issueDate ?? "x"}-${String(i)}`} data-testid="finance-ar-invoice" className="grid grid-cols-2 gap-x-3 gap-y-1 py-2 text-small md:grid-cols-4">
                <span><span className="text-muted-foreground md:hidden">Invoice date </span>{d.issueDate ? formatDay(d.issueDate) : "Not recorded"}</span>
                <span><span className="text-muted-foreground md:hidden">Due date </span>{d.dueDate ? formatDay(d.dueDate) : "No due date"}</span>
                <span className="tabular-nums md:text-right"><span className="text-muted-foreground md:hidden">Days overdue </span>{String(d.daysOverdue)}</span>
                <span className="font-medium tabular-nums md:text-right"><span className="text-muted-foreground md:hidden">Balance </span>{formatMoney(d.balance)}</span>
              </li>
            ))}
          </ul>
          {c.invoices > c.detail.length ? (
            <Small testId="finance-ar-detail-cap">{`Showing the ${String(c.detail.length)} oldest of ${String(c.invoices)} open invoices. The row's figures count all of them.`}</Small>
          ) : null}
        </div>
      </details>
    </li>
  );
}

function CheckLine({ check, total }: { check: ArCheck | null; total: number | null }) {
  if (check === null) return null;
  if (check.kind === "missing") {
    return (
      <div data-testid="finance-ar-check" className="flex flex-col gap-1 border-t border-border pt-3">
        <Small>{`QuickBooks AR aging report: the report total is not available. ${CHECK_REASON_TEXT[check.reason]}`}</Small>
      </div>
    );
  }
  return (
    <div data-testid="finance-ar-check" className="flex flex-col gap-1 border-t border-border pt-3">
      <p className="text-body text-foreground">{`QuickBooks AR aging report, as of ${formatDay(check.reportDate)}: ${formatMoney(check.total)}`}</p>
      <p data-testid="finance-ar-difference" className="text-body text-foreground">
        {`Difference from the total above${total === null ? "" : ` (${formatMoney(total)})`}: ${formatMoney(check.difference)}`}
      </p>
      <Small>{CREDITS_NOTE}</Small>
    </div>
  );
}

function ReceivablesBody({ data }: { data: ReceivablesData }) {
  const note = data.businessDate ? `As of ${formatDay(data.businessDate)}${data.asOf ? ` · data from ${formatAsOf(data.asOf)}` : ""}` : "Point in time";
  if (data.customers.length === 0 || data.total === null || data.buckets.length !== 5) {
    return <PageSection title="Aged receivables by customer" note={note} emptyTitle={data.invoiceCount === 0 && data.total !== null ? "No open invoices" : "Not available yet"} />;
  }
  const bucketTotals = Object.fromEntries(data.buckets.map((b) => [b.bucket, b.total])) as Record<(typeof AGING_BUCKETS)[number], number>;
  const hidden = data.customerCount - data.customers.length;
  return (
    <PageSection title="Aged receivables by customer" note={note}>
      <div data-testid="finance-ar-table" className="flex flex-col">
        <div aria-hidden className={`hidden border-b border-border pb-2 text-label text-muted-foreground ${GRID}`}>
          <span>Customer</span>
          {AGING_BUCKETS.map((b) => <span key={b} className="text-right">{AGING_LABEL[b]}</span>)}
          <span className="text-right">Total</span>
          <span className="text-right">Open invoices</span>
        </div>
        <ul className="flex flex-col divide-y divide-border">
          {data.customers.map((c, i) => <CustomerRow key={`${c.name ?? "unknown"}-${String(i)}`} c={c} />)}
        </ul>
        <div data-testid="finance-ar-total" className={`flex flex-col gap-1 border-t-2 border-border pt-3 text-body font-semibold text-foreground ${GRID}`}>
          <span data-field="customer">Total</span>
          <Figures buckets={bucketTotals} total={data.total} invoices={data.invoiceCount} />
        </div>
      </div>
      {hidden > 0 ? (
        <Small testId="finance-ar-cap">{`Showing the ${String(data.customers.length)} customers with the largest balances. ${plural(hidden, "customer is", "customers are")} not shown. The totals row counts all ${String(data.customerCount)} customers.`}</Small>
      ) : null}
      <Small testId="finance-ar-rule">{`${BUCKET_RULE} Invoice numbers are not stored here.`}</Small>
      <CheckLine check={data.check} total={data.total} />
    </PageSection>
  );
}

export function ReceivablesView({ laneId, laneName, data }: { laneId: string; laneName: string; data: Receivables }) {
  const status = data.state === "unavailable" || data.state === "no_access" ? { state: data.state } : { state: data.state, lastSyncAt: data.lastSyncAt, connectionStatus: data.connectionStatus };
  return (
    <ReportFrame laneId={laneId} laneName={laneName} accent="receivables" active="receivables" title="Aged receivables by customer" status={status}>
      {data.state === "ok" ? (
        <CardBoundary label="Aged receivables" kind="section">
          <ReceivablesBody data={data} />
        </CardBoundary>
      ) : (
        <PageSection title="Aged receivables by customer" emptyTitle={UNAVAILABLE} />
      )}
    </ReportFrame>
  );
}

async function loadData(laneId: string): Promise<Receivables> {
  const g = await guards();
  const data = await timed("load.finance.receivables", async () => receivablesFor(g, laneId));
  // An outage is shown only to a caller who holds the lane's finance view; anyone else sees no figures.
  if (data.state === "unavailable" && !(await hasFinanceView(g, laneId))) return { state: "no_access" };
  return data;
}

/** The page's read, once per request (React cache), started by the route page beside the module gate (T-276). */
const receivablesData = cache((laneId: string) => loadData(laneId));

export function startReceivables(params: Promise<{ laneId: string }>): void {
  void params.then((p) => receivablesData(p.laneId)).catch(() => undefined);
}

export async function ReceivablesPage({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const data = await receivablesData(lane.laneId);
  return <ReceivablesView laneId={lane.laneId} laneName={lane.name} data={data} />;
}
