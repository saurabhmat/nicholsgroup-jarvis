// Finance at a glance (D-20 batch 1, p4): header, period toggle, four figure cards and the section skeletons as empty
// states. Figures come from SQL in T-095; nothing here is a number. Cash is always "book balance" (rule 7).
import { KpiCard, PageHeader, PageSection, PeriodToggle } from "@nichols/ui";
import { loadLane } from "@/lib/lane-page";

export async function FinancePage({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={lane.name} title="Finance" accent="at a glance" actions={<PeriodToggle />} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Cash" headingLevel="h2" bookBalance qualifier="Per QuickBooks, not the bank" />
        <KpiCard label="Accounts receivable" headingLevel="h2" />
        <KpiCard label="Bills due in 14 days" headingLevel="h2" qualifier="Point in time" />
        <KpiCard label="Net income" headingLevel="h2" qualifier="For the selected period" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <PageSection title="Subscriptions" note="Revenue: Stripe · Subscribers: GoHighLevel" emptyTitle="No subscription data yet" emptyDescription="MRR, revenue churn and paid subscribers appear here once the payment and subscriber sources are connected." />
        <PageSection title="Receivables aging" note="Point in time" emptyTitle="No receivables data yet" emptyDescription="Aging buckets appear here once the accounting source is connected." />
      </div>
      <PageSection title="Cash by account" note="Book balance, per QuickBooks" emptyTitle="No accounts yet" emptyDescription="Each account's book balance, bank feed status and last reconciliation appear here." />
      <div className="grid gap-6 lg:grid-cols-2">
        <PageSection title="Controls" emptyTitle="No controls yet" emptyDescription="Reconciliation and feed checks appear here." />
        <PageSection title="Reports" emptyTitle="No reports yet" emptyDescription="The weekly cash report (Sat–Fri) and month-end snapshots appear here." />
      </div>
    </div>
  );
}
