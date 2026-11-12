// Home "Finance" section (T-237 part C), desktop and tablet only (hidden below md: the iPhone design omits it). Figures come from SQL
// (core.home_finance, core.home_finance_detail) and are only formatted here (rule 7); the bar WIDTHS are display-only proportions
// of two or five SQL figures. Labelled "Income", not "Revenue": Stripe is the source of revenue (rule 8). Hidden when QuickBooks is
// not connected or the role has no finance view; an unavailable read is one muted line. Every bar has its figure as text.
import Link from "next/link";
import { laneHref } from "@nichols/ui";
import { connectionNote, emptyStateText, financeCards, formatAsOf, formatMoney, formatMonth, type HomeFinanceView } from "@/lib/home-finance";
import { AGING_LABEL, barWidths, type HomeFinanceDetail } from "@/lib/home-finance-detail";

const AGING_BAR = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-danger", "bg-chart-4"] as const;
const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

function Bar({ pct, className }: { pct: number; className: string }) {
  return (
    <div aria-hidden className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${String(pct)}%` }} />
    </div>
  );
}

const COL_TITLE = "font-sans text-label font-medium uppercase tracking-wide text-muted-foreground";

function Shell({ children, note, laneId }: { children: React.ReactNode; note?: string; laneId: string }) {
  return (
    <section aria-label="Finance" data-testid="home-finance" className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-6 text-body text-card-foreground shadow-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-card-title font-semibold text-foreground">
          Finance {note ? <span data-testid="finance-as-of" className="font-sans text-small font-normal text-muted-foreground">{`· ${note}`}</span> : null}
        </h2>
        <Link href={laneHref(laneId, "finance")} className="text-small font-medium text-primary underline-offset-2 hover:underline">
          Open Finance <span aria-hidden>{"→"}</span>
        </Link>
      </div>
      {children}
    </section>
  );
}

export function HomeFinanceSection({ laneId, finance, detail }: { laneId: string; finance: HomeFinanceView; detail: HomeFinanceDetail }) {
  if (finance.state === "no_access" || finance.state === "not_connected") return null;
  if (finance.state === "unavailable") {
    return (
      <Shell laneId={laneId}>
        <p data-testid="finance-unavailable" className="text-small text-muted-foreground">Finance figures could not be loaded. Reload in a minute.</p>
      </Shell>
    );
  }
  const empty = emptyStateText(finance);
  if (empty !== null) {
    return (
      <Shell laneId={laneId}>
        <p data-testid="finance-empty" className="text-small text-muted-foreground">{empty}</p>
      </Shell>
    );
  }
  const asOf = finance.asOf ?? (detail.state === "ok" ? detail.asOf : null);
  const stale = connectionNote(finance);
  const pnlCard = financeCards(finance).find((c) => c.key === "pnl");
  const p = finance.pnl;
  const pnlOk = p.reason === null && p.income !== null && p.expenses !== null && p.net !== null;
  const widths = pnlOk ? barWidths([p.income as number, p.expenses as number]) : [0, 0];
  const month = p.start ? formatMonth(p.start).split(" ")[0] : null;
  const det = detail.state === "ok" ? detail : null;
  const agingWidths = det ? barWidths(det.aging.map((a) => a.total)) : [];
  const unmapped = det && det.unmappedInvoices > 0 ? `Excludes ${plural(det.unmappedInvoices, "invoice", "invoices")} with no company` : null;
  return (
    <Shell laneId={laneId} {...(asOf ? { note: `QuickBooks, book figures as of ${formatAsOf(asOf)}` } : {})}>
      {stale ? <p className="text-small text-muted-foreground">{stale}</p> : null}
      <div className="grid gap-6 md:grid-cols-3">
        <div data-testid="finance-mtd" className="flex min-w-0 flex-col gap-3">
          <h3 className={COL_TITLE}>{month ? `${month} to date` : "Month to date"}</h3>
          {pnlOk ? (
            <>
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-body"><span>Income</span><span className="font-semibold tabular-nums">{formatMoney(p.income as number)}</span></div>
                <Bar pct={widths[0] ?? 0} className="bg-chart-1" />
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-body"><span>Expenses</span><span className="font-semibold tabular-nums">{formatMoney(p.expenses as number)}</span></div>
                <Bar pct={widths[1] ?? 0} className="bg-chart-3" />
              </div>
              <div className="flex items-baseline justify-between gap-2 border-t border-border pt-3 text-body">
                <span className="font-medium">Net income</span>
                <span data-testid="finance-net" className={`font-semibold tabular-nums ${(p.net as number) > 0 ? "text-success" : (p.net as number) < 0 ? "text-danger" : "text-foreground"}`}>{formatMoney(p.net as number)}</span>
              </div>
              {p.partial ? <p className="text-small text-muted-foreground">Excludes payroll accounts</p> : null}
            </>
          ) : (
            <p className="text-small text-muted-foreground">{pnlCard?.statusText ?? "Not available yet"}</p>
          )}
        </div>
        <div data-testid="finance-aging" className="flex min-w-0 flex-col gap-3">
          <h3 className={COL_TITLE}>Receivables aging</h3>
          {det && det.aging.length === 5 ? (
            <ul className="flex flex-col gap-2">
              {det.aging.map((a, i) => (
                <li key={a.bucket} data-bucket={a.bucket} className="flex items-center gap-3 text-small">
                  <span className="w-12 shrink-0 text-muted-foreground">{AGING_LABEL[a.bucket]}</span>
                  <Bar pct={agingWidths[i] ?? 0} className={AGING_BAR[i] ?? "bg-chart-1"} />
                  <span className="w-24 shrink-0 text-right font-medium tabular-nums text-foreground">{formatMoney(a.total)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-small text-muted-foreground">{detail.state === "unavailable" ? "Could not load. Reload in a minute." : "Not available yet"}</p>
          )}
          {unmapped ? <p className="text-small text-muted-foreground">{unmapped}</p> : null}
        </div>
        <div data-testid="finance-oldest" className="flex min-w-0 flex-col gap-3">
          <h3 className={COL_TITLE}>Oldest unpaid invoices</h3>
          {det ? (
            det.oldest.length > 0 ? (
              <ul className="flex flex-col divide-y divide-border">
                {det.oldest.map((o, i) => (
                  <li key={String(i)} data-testid="finance-oldest-row" className="flex items-start justify-between gap-3 py-2 first:pt-0">
                    <span className="flex min-w-0 flex-col">
                      {o.customer ? <span data-testid="finance-oldest-customer" className="truncate text-body text-foreground">{o.customer}</span> : null}
                      <span className="text-small text-danger">{`${plural(o.daysOverdue, "day", "days")} overdue`}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums text-foreground">{formatMoney(o.balance)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-small text-muted-foreground">No overdue invoices</p>
            )
          ) : (
            <p className="text-small text-muted-foreground">{detail.state === "unavailable" ? "Could not load. Reload in a minute." : "Not available yet"}</p>
          )}
        </div>
      </div>
    </Shell>
  );
}
