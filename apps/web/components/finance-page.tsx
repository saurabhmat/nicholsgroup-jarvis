// Finance at a glance (D-20 batch 1, p4; T-244 wires it to live QuickBooks data). Every figure comes from SQL (core.home_finance,
// core.home_finance_detail, core.finance_pnl, core.finance_overview) and is only formatted here (rule 7). Cash is "book balance".
// The period toggle is a set of links (`?period=week|mtd|ytd`): the page renders per request on the server. Subscriptions
// (Stripe, GoHighLevel) stay empty until those sources are connected. A role without the finance view sees no figures.
import Link from "next/link";
import { EmptyState, KpiCard, PageHeader, PageSection, PERIODS, laneHref } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { loadLane } from "@/lib/lane-page";
import { CardBoundary } from "./card-boundary";
import { timed } from "@/lib/timed";
import { CONNECT_TEXT, connectionNote, emptyStateText, financeCards, formatAsOf, formatMoney, hasFinanceView, homeFinanceFor, type HomeFinanceView } from "@/lib/home-finance";
import { AGING_LABEL, barWidths, homeFinanceDetailFor, type HomeFinanceDetail } from "@/lib/home-finance-detail";
import {
  CONTROLS_MISSING,
  DEFAULT_PERIOD,
  PERIOD_LABEL,
  REPORTS_MISSING,
  controlRows,
  financeOverviewFor,
  financePnlFor,
  formatRange,
  parsePeriod,
  pnlReasonText,
  reportLine,
  type FinanceOverview,
  type FinancePeriod,
  type FinancePnl,
} from "@/lib/finance-page";

const AGING_BAR = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-danger", "bg-chart-4"] as const;
const UNAVAILABLE = "Could not load. Reload in a minute.";
const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

export type FinanceData = { finance: HomeFinanceView; detail: HomeFinanceDetail; pnl: FinancePnl; overview: FinanceOverview };

async function loadData(laneId: string, period: FinancePeriod): Promise<FinanceData> {
  const g = await guards();
  const [finance, detail, pnl, overview] = await Promise.all([
    timed("load.finance.home_finance", async () => homeFinanceFor(g, laneId)),
    timed("load.finance.detail", async () => homeFinanceDetailFor(g, laneId)),
    timed("load.finance.pnl", async () => financePnlFor(g, laneId, period)),
    timed("load.finance.overview", async () => financeOverviewFor(g, laneId)),
  ]);
  // An outage is shown only to a caller who holds the lane's finance view; anyone else sees no figures (the check runs only during an outage).
  if ([finance, detail, pnl, overview].some((v) => v.state === "unavailable") && !(await hasFinanceView(g, laneId))) {
    const none = { state: "no_access" } as const;
    return { finance: none, detail: none, pnl: none, overview: none };
  }
  return { finance, detail, pnl, overview };
}

function PeriodLinks({ laneId, period }: { laneId: string; period: FinancePeriod }) {
  return (
    <nav aria-label="Period" data-testid="finance-period" className="inline-flex max-w-full flex-wrap overflow-hidden rounded-control border border-border bg-card">
      {PERIODS.map((p) => (
        <Link
          key={p.key}
          href={p.key === DEFAULT_PERIOD ? laneHref(laneId, "finance") : `${laneHref(laneId, "finance")}?period=${p.key}`}
          aria-current={period === p.key ? "page" : undefined}
          data-period={p.key}
          className={`px-3 py-2 text-body ${period === p.key ? "bg-primary font-semibold text-primary-foreground" : "text-foreground hover:bg-accent"}`}
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}

const Small = ({ children, testId }: { children: React.ReactNode; testId?: string }) => (
  <p {...(testId ? { "data-testid": testId } : {})} className="text-small text-muted-foreground">{children}</p>
);

function Bar({ pct, className }: { pct: number; className: string }) {
  return (
    <div aria-hidden className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${String(pct)}%` }} />
    </div>
  );
}

function Footer({ lines, connectLink, laneId }: { lines: string[]; connectLink?: boolean; laneId: string }) {
  if (lines.length === 0 && !connectLink) return null;
  return (
    <div className="flex flex-col gap-1">
      {lines.map((l) => <Small key={l}>{l}</Small>)}
      {connectLink ? <Link href={`${laneHref(laneId, "settings")}#connections`} className="text-small font-medium text-primary underline-offset-2 hover:underline">{CONNECT_TEXT}</Link> : null}
    </div>
  );
}

type CardProps = { laneId: string; period: FinancePeriod; data: FinanceData };
const asOfLine = (iso: string | null) => (iso ? `As of ${formatAsOf(iso)}` : null);
const present = (xs: (string | null)[]) => xs.filter((x): x is string => x !== null);

/** The page-wide state text for every card (not connected, mapping missing, no data, outage), or null when figures can show. */
function pageEmpty(finance: HomeFinanceView): { text: string; connectLink: boolean } | null {
  if (finance.state === "no_access") return null;
  if (finance.state === "unavailable") return { text: UNAVAILABLE, connectLink: false };
  const text = emptyStateText(finance);
  return text === null ? null : { text, connectLink: finance.state === "not_connected" };
}

function emptyProps(e: { text: string; connectLink: boolean }, laneId: string) {
  return { statusText: e.text, footer: <Footer lines={[]} connectLink={e.connectLink} laneId={laneId} /> };
}

function CashCard({ laneId, data }: CardProps) {
  const head = { label: "Cash", headingLevel: "h2", bookBalance: true, qualifier: "Per QuickBooks, not the bank" } as const;
  const e = pageEmpty(data.finance);
  if (e) return <KpiCard {...head} {...emptyProps(e, laneId)} />;
  const cash = financeCards(data.finance).find((c) => c.key === "cash");
  const lines = present([cash?.asOf ?? null, ...(cash?.flags ?? [])]);
  return <KpiCard {...head} {...(cash?.value ? { value: cash.value } : { statusText: cash?.statusText ?? UNAVAILABLE })} footer={<Footer lines={lines} laneId={laneId} />} />;
}

function ArCard({ laneId, data }: CardProps) {
  const { detail, overview } = data;
  const head = { label: "Accounts receivable", headingLevel: "h2", qualifier: "Open invoices" } as const;
  const e = pageEmpty(data.finance);
  if (e) return <KpiCard label={head.label} headingLevel="h2" {...emptyProps(e, laneId)} />;
  const lines = present([
    overview.state === "ok" ? "All open invoices; equals the receivables aging total" : null,
    asOfLine(overview.state === "ok" ? overview.asOf : null),
    detail.state === "ok" && detail.unmappedInvoices > 0 ? `Excludes ${plural(detail.unmappedInvoices, "invoice", "invoices")} with no company` : null,
  ]);
  const value = overview.state === "ok" && overview.arTotal !== null ? { value: formatMoney(overview.arTotal) } : { statusText: overview.state === "unavailable" ? UNAVAILABLE : "No invoices synced yet" };
  return <KpiCard {...head} {...value} footer={<Footer lines={lines} laneId={laneId} />} />;
}

function BillsCard({ laneId, data }: CardProps) {
  const { detail } = data;
  const head = { label: "Bills due in 14 days", headingLevel: "h2", qualifier: "Point in time" } as const;
  const e = pageEmpty(data.finance);
  if (e) return <KpiCard {...head} {...emptyProps(e, laneId)} />;
  const lines = present([
    detail.state === "ok" ? plural(detail.bills.count, "bill", "bills") : null,
    asOfLine(detail.state === "ok" ? detail.asOf : null),
    detail.state === "ok" && detail.unmappedBills > 0 ? `Excludes ${plural(detail.unmappedBills, "bill", "bills")} with no company` : null,
  ]);
  const value = detail.state === "ok" && detail.bills.total !== null ? { value: formatMoney(detail.bills.total) } : { statusText: detail.state === "unavailable" ? UNAVAILABLE : "Not available yet" };
  return <KpiCard {...head} {...value} footer={<Footer lines={lines} laneId={laneId} />} />;
}

function NetIncomeCard({ laneId, period, data }: CardProps) {
  const { pnl } = data;
  const e = pageEmpty(data.finance);
  if (e) return <KpiCard label="Net income" headingLevel="h2" qualifier={PERIOD_LABEL[period]} {...emptyProps(e, laneId)} />;
  const window = pnl.state === "ok" && pnl.windowStart && pnl.windowEnd ? formatRange(pnl.windowStart, pnl.windowEnd) : null;
  const qualifier = window ? `${PERIOD_LABEL[period]} · ${window}` : PERIOD_LABEL[period];
  if (pnl.state === "ok" && pnl.reason === null && pnl.net !== null && pnl.income !== null && pnl.expenses !== null) {
    const lines = present([
      `Income ${formatMoney(pnl.income)} · Expenses ${formatMoney(pnl.expenses)}`,
      pnl.start && pnl.end ? `Report covers ${formatRange(pnl.start, pnl.end)}${pnl.method ? ` · ${pnl.method === "cash" ? "Cash" : "Accrual"} basis` : ""}` : null,
      asOfLine(pnl.reportAsOf),
      pnl.partial ? "Excludes payroll accounts" : null,
    ]);
    return <KpiCard label="Net income" headingLevel="h2" qualifier={qualifier} value={formatMoney(pnl.net)} footer={<Footer lines={lines} laneId={laneId} />} />;
  }
  const statusText = pnl.state === "unavailable" ? UNAVAILABLE : pnl.state === "ok" && pnl.reason ? pnlReasonText(pnl.reason) : "Not available yet";
  return <KpiCard label="Net income" headingLevel="h2" qualifier={qualifier} statusText={statusText} footer={<Footer lines={[]} laneId={laneId} />} />;
}

const KPI_CARDS = [
  { key: "cash", label: "Cash", Card: CashCard },
  { key: "ar", label: "Accounts receivable", Card: ArCard },
  { key: "bills", label: "Bills due in 14 days", Card: BillsCard },
  { key: "net", label: "Net income", Card: NetIncomeCard },
] as const;

function emptySection(title: string, note: string | undefined, text: string) {
  return <PageSection title={title} {...(note ? { note } : {})} emptyTitle={text} />;
}

function AgingSection({ finance, detail, overview }: Pick<FinanceData, "finance" | "detail" | "overview">) {
  const empty = finance.state !== "no_access" && finance.state !== "unavailable" ? emptyStateText(finance) : null;
  if (empty !== null) return emptySection("Receivables aging", "Point in time", empty);
  if (detail.state === "unavailable") return emptySection("Receivables aging", "Point in time", UNAVAILABLE);
  if (detail.state !== "ok") return emptySection("Receivables aging", "Point in time", "No receivables data yet");
  if (detail.aging.length !== 5) return emptySection("Receivables aging", "Point in time", "Not available yet");
  const widths = barWidths(detail.aging.map((a) => a.total));
  return (
    <PageSection title="Receivables aging" note="Point in time" ariaLabel="Receivables aging">
      <div data-testid="finance-aging" className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {detail.aging.map((a, i) => (
            <li key={a.bucket} data-bucket={a.bucket} className="flex items-center gap-3 text-small">
              <span className="w-12 shrink-0 text-muted-foreground">{AGING_LABEL[a.bucket]}</span>
              <Bar pct={widths[i] ?? 0} className={AGING_BAR[i] ?? "bg-chart-1"} />
              <span className="w-24 shrink-0 text-right font-medium tabular-nums text-foreground">{formatMoney(a.total)}</span>
            </li>
          ))}
        </ul>
        {overview.state === "ok" && overview.arTotal !== null ? (
          <div className="flex items-baseline justify-between gap-2 border-t border-border pt-3 text-body">
            <span className="font-medium">Total open receivables</span>
            <span data-testid="finance-aging-total" className="font-semibold tabular-nums">{formatMoney(overview.arTotal)}</span>
          </div>
        ) : null}
        {detail.unmappedInvoices > 0 ? <Small>{`Excludes ${plural(detail.unmappedInvoices, "invoice", "invoices")} with no company`}</Small> : null}
      </div>
    </PageSection>
  );
}

function CashSection({ finance }: { finance: HomeFinanceView }) {
  const note = "Book balance, per QuickBooks";
  if (finance.state === "no_access") return null;
  const empty = emptyStateText(finance);
  if (empty !== null) return emptySection("Cash by account", note, empty);
  if (finance.state !== "ok") return null;
  const cash = financeCards(finance).find((c) => c.key === "cash");
  if (finance.cash.reason !== null || finance.cash.total === null) return emptySection("Cash by account", note, cash?.statusText ?? "Not available yet");
  const sync = finance.lastSyncAt ? `Last sync ${formatAsOf(finance.lastSyncAt)}` : "Not synced yet";
  return (
    <PageSection title="Cash by account" note={note}>
      <ul data-testid="finance-cash-accounts" className="flex flex-col divide-y divide-border">
        {finance.cash.accounts.map((a, i) => (
          <li key={`${a.name}-${String(i)}`} data-testid="finance-cash-row" className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3 first:pt-0">
            <span className="flex min-w-0 flex-col">
              <span className="flex flex-wrap items-center gap-2 text-body text-foreground">
                <span className="truncate">{a.name}</span>
                {a.shared ? <span className="rounded-control border border-border px-2 text-label text-muted-foreground">Shared account</span> : null}
              </span>
              <span className="text-small text-muted-foreground">{sync}</span>
            </span>
            <span className="shrink-0 font-semibold tabular-nums text-foreground">{a.bookBalance === null ? "No balance yet" : formatMoney(a.bookBalance)}</span>
          </li>
        ))}
      </ul>
      {finance.cash.unmapped > 0 ? <Small>{`${plural(finance.cash.unmapped, "bank account is", "bank accounts are")} not mapped to a company. ${finance.cash.unmapped === 1 ? "It is" : "They are"} not listed or counted in cash.`}</Small> : null}
    </PageSection>
  );
}

function ControlsSection({ data }: { data: FinanceData }) {
  const { finance, detail, overview } = data;
  if (finance.state === "no_access") return null;
  const empty = finance.state === "unavailable" ? UNAVAILABLE : emptyStateText(finance);
  if (empty !== null || finance.state !== "ok") return emptySection("Controls", undefined, empty ?? "Not available yet");
  const rows = controlRows({
    connectionStatus: finance.connectionStatus,
    lastSyncAt: finance.lastSyncAt,
    lastNormalizedAt: overview.state === "ok" ? overview.lastNormalizedAt : null,
    unmappedBankAccounts: finance.cash.unmapped,
    bankMappingMissing: finance.cash.reason === "bank_mapping_missing",
    unmappedInvoices: detail.state === "ok" ? detail.unmappedInvoices : null,
    unmappedBills: overview.state === "ok" ? overview.unmappedBillsOpen : null,
    sharedAccountNames: finance.cash.accounts.filter((a) => a.shared).map((a) => a.name),
  });
  return (
    <PageSection title="Controls" note="What exists today">
      <ul data-testid="finance-controls" className="flex flex-col divide-y divide-border">
        {rows.map((r) => (
          <li key={r.key} data-control={r.key} data-status={r.status} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0">
            <span className="text-body text-foreground">{r.label}</span>
            <span className={`text-small font-medium ${r.status === "ok" ? "text-success" : "text-danger"}`}>{r.text}</span>
          </li>
        ))}
      </ul>
      {overview.state === "unavailable" ? <Small>{"Some checks could not load. Reload in a minute."}</Small> : null}
      <Small testId="finance-controls-missing">{CONTROLS_MISSING}</Small>
    </PageSection>
  );
}

function ReportsSection({ data }: { data: FinanceData }) {
  const { finance, overview } = data;
  if (finance.state === "no_access") return null;
  const empty = finance.state === "unavailable" || overview.state === "unavailable" ? UNAVAILABLE : emptyStateText(finance);
  if (empty !== null) return emptySection("Reports", undefined, empty);
  if (overview.state !== "ok") return emptySection("Reports", undefined, "Not available yet");
  return (
    <PageSection title="Reports" note="Cached from QuickBooks">
      {overview.reports.length === 0 ? (
        <EmptyState title="No reports cached yet" description="QuickBooks reports are fetched nightly once the connection is active." className="border-0 bg-transparent px-0 py-6" />
      ) : (
        <ul data-testid="finance-reports" className="flex flex-col divide-y divide-border">
          {overview.reports.map((r, i) => {
            const l = reportLine(r);
            return (
              <li key={`${r.report}-${String(i)}`} data-testid="finance-report-row" className="flex flex-col gap-0.5 py-2 first:pt-0">
                <span className="text-body text-foreground">{l.title}</span>
                <span className="text-small text-muted-foreground">{l.covers}</span>
                <span className="text-small text-muted-foreground">{l.cached}</span>
              </li>
            );
          })}
        </ul>
      )}
      <Small testId="finance-reports-missing">{REPORTS_MISSING}</Small>
    </PageSection>
  );
}

export function FinanceView({ laneId, laneName, period, data }: { laneId: string; laneName: string; period: FinancePeriod; data: FinanceData }) {
  const header = <PageHeader eyebrow={laneName} title="Finance" accent="at a glance" {...(data.finance.state === "no_access" ? {} : { actions: <PeriodLinks laneId={laneId} period={period} /> })} />;
  if (data.finance.state === "no_access") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState title="No access to finance figures" description="Finance figures are shown to roles with the finance view for this company." />
      </div>
    );
  }
  const note = connectionNote(data.finance);
  return (
    <div className="flex flex-col gap-6">
      {header}
      {note ? <p data-testid="finance-connection-note" className="text-small text-muted-foreground">{note}</p> : null}
      {/* Keyed on the period: a card that failed gets a fresh boundary when the period link changes (soft navigation). */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {KPI_CARDS.map(({ key, label, Card }) => (
          <CardBoundary key={`${key}-${period}`} label={label} kind="kpi">
            <Card laneId={laneId} period={period} data={data} />
          </CardBoundary>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <PageSection title="Subscriptions" note="Revenue: Stripe · Subscribers: GoHighLevel" emptyTitle="No subscription data yet" emptyDescription="MRR, revenue churn and paid subscribers appear here once the payment and subscriber sources are connected." />
        <CardBoundary key={period} label="Receivables aging" kind="section">
          <AgingSection finance={data.finance} detail={data.detail} overview={data.overview} />
        </CardBoundary>
      </div>
      <CardBoundary key={period} label="Cash by account" kind="section">
        <CashSection finance={data.finance} />
      </CardBoundary>
      <div className="grid gap-6 lg:grid-cols-2">
        <CardBoundary key={period} label="Controls" kind="section">
          <ControlsSection data={data} />
        </CardBoundary>
        <CardBoundary key={period} label="Reports" kind="section">
          <ReportsSection data={data} />
        </CardBoundary>
      </div>
    </div>
  );
}

export async function FinancePage({ params, searchParams }: { params: Promise<{ laneId: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const lane = await loadLane((await params).laneId);
  const period = parsePeriod(searchParams ? (await searchParams).period : undefined);
  const data = await loadData(lane.laneId, period);
  return <FinanceView laneId={lane.laneId} laneName={lane.name} period={period} data={data} />;
}
