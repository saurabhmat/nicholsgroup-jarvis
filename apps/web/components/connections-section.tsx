// Settings -> Connections (T-230 B): one compact list for every provider the user may manage: Google rows (T-199), the
// QuickBooks row (T-233) and Composio rows (T-219), then Coverage per source (T-234: moved here from Home). Which providers appear is decided by the loaders (owner or admin_technical at AAL2); a provider
// whose view is null is not drawn at all. This component only draws.
import { Card, CardDescription, CardHeader, CardTitle } from "@nichols/ui";
import type { ComposioSectionView } from "@/lib/composio-connection";
import type { GoogleSectionView } from "@/lib/google-connection";
import type { QuickBooksSectionView } from "@/lib/quickbooks-connection";
import type { CoverageView } from "@/lib/coverage";
import { CoverageList } from "./coverage-list";
import { JobFailureBanner } from "./job-failure-banner";
import type { JobFailureItem } from "@/lib/job-failures";
import { ComposioNotes, ComposioNotices, ComposioRows } from "./composio-connection-section";
import { ConnectionsHeader } from "./connection-rows";
import { GoogleNotes, GoogleNotices, GoogleRows, GoogleSyncBar } from "./google-connection-section";
import { QuickBooksNotes, QuickBooksNotices, QuickBooksRows } from "./quickbooks-connection-section";

export function ConnectionsSection({ laneId, google, quickbooks, composio, coverage = null, jobFailures = null, tz = "America/New_York", now = new Date() }: { laneId: string; google: GoogleSectionView | null; quickbooks: QuickBooksSectionView | null; composio: ComposioSectionView | null; coverage?: CoverageView | null; jobFailures?: JobFailureItem[] | null; tz?: string; now?: Date }) {
  return (
    <section id="connections" aria-labelledby="connections-title" className="scroll-mt-8">
      <Card>
        <CardHeader>
          <CardTitle as="h2" id="connections-title">
            Connections
          </CardTitle>
          <CardDescription>The accounts that feed this company&apos;s mail, calendar and files into the portal.</CardDescription>
        </CardHeader>
        <JobFailureBanner laneId={laneId} items={jobFailures} now={now} onSettings />
        {google ? <GoogleNotices view={google} /> : null}
        {google ? <GoogleSyncBar laneId={laneId} view={google} /> : null}
        {quickbooks ? <QuickBooksNotices view={quickbooks} /> : null}
        {composio ? <ComposioNotices view={composio} /> : null}
        <ul data-testid="connections-list" className="flex flex-col divide-y divide-border">
          <ConnectionsHeader />
          {google ? <GoogleRows laneId={laneId} view={google} /> : null}
          {quickbooks ? <QuickBooksRows laneId={laneId} view={quickbooks} /> : null}
          {composio ? <ComposioRows laneId={laneId} view={composio} /> : null}
        </ul>
        {google ? <GoogleNotes /> : null}
        {quickbooks ? <QuickBooksNotes laneId={laneId} now={now} /> : null}
        {composio ? <ComposioNotes view={composio} /> : null}
        {coverage ? <CoverageList view={coverage} tz={tz} now={now} /> : null}
      </Card>
    </section>
  );
}
