// Settings -> Connections (T-230 B): one compact list for every provider the user may manage: Google rows (T-199), the
// QuickBooks row (T-233) and Composio rows (T-219), then Coverage per source (T-234: moved here from Home). Which providers appear is decided by the loaders (owner or admin_technical at AAL2); a provider
// whose view is null is not drawn at all. This component only draws.
import { Card, CardDescription, CardHeader, CardTitle } from "@nichols/ui";
import type { ComposioSectionView } from "@/lib/composio-connection";
import type { GoogleSectionView } from "@/lib/google-connection";
import type { MicrosoftSectionView } from "@/lib/microsoft-connection";
import type { QuickBooksSectionView } from "@/lib/quickbooks-connection";
import type { CoverageView } from "@/lib/coverage";
import { CoverageList } from "./coverage-list";
import { JobFailureBanner } from "./job-failure-banner";
import type { JobFailureItem } from "@/lib/job-failures";
import { ComposioNotes, ComposioNotices, ComposioRows } from "./composio-connection-section";
import { SyncNowButton } from "./sync-now-button";
import { ConnectionsHeader } from "./connection-rows";
import { GoogleNotes, GoogleNotices, GoogleRows } from "./google-connection-section";
import { MicrosoftNotes, MicrosoftNotices, MicrosoftRows } from "./microsoft-connection-section";
import { QuickBooksNotes, QuickBooksNotices, QuickBooksRows } from "./quickbooks-connection-section";

/**
 * T-270: "Sync now" once for the whole section, whatever the providers (it used to sit inside the Google section, so a Microsoft-only company had none).
 * Drawn when the person may sync (owner or admin_technical: canSync, set by the loaders) and at least one provider view that is readable and not paused
 * lists a connection that is connected or degraded. The button syncs every mail and calendar connection of the company (POST /api/lanes/<lane>/sync-now).
 */
export function SyncBar({ laneId, views }: { laneId: string; views: ReadonlyArray<GoogleSectionView | null> }) {
  const live = views.filter((v): v is GoogleSectionView => v !== null && !v.unavailable && !v.paused);
  if (!live.some((v) => v.canSync) || !live.some((v) => v.connections.some((c) => c.state === "connected" || c.state === "degraded"))) return null;
  return (
    <div data-testid="sync-bar" className="flex flex-wrap items-center gap-3 text-small text-muted-foreground">
      <span>Mail and calendar sync every 15 minutes. To check for new items right now:</span>
      <SyncNowButton laneId={laneId} testId="settings-sync-now" />
    </div>
  );
}

export function ConnectionsSection({ laneId, google, microsoft = null, quickbooks, composio, coverage = null, jobFailures = null, tz = "America/New_York", now = new Date() }: { laneId: string; google: GoogleSectionView | null; microsoft?: MicrosoftSectionView | null; quickbooks: QuickBooksSectionView | null; composio: ComposioSectionView | null; coverage?: CoverageView | null; jobFailures?: JobFailureItem[] | null; tz?: string; now?: Date }) {
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
        <SyncBar laneId={laneId} views={[google, microsoft]} />
        {microsoft ? <MicrosoftNotices view={microsoft} /> : null}
        {quickbooks ? <QuickBooksNotices view={quickbooks} /> : null}
        {composio ? <ComposioNotices view={composio} /> : null}
        <ul data-testid="connections-list" className="flex flex-col divide-y divide-border">
          <ConnectionsHeader />
          {google ? <GoogleRows laneId={laneId} view={google} /> : null}
          {microsoft ? <MicrosoftRows laneId={laneId} view={microsoft} /> : null}
          {quickbooks ? <QuickBooksRows laneId={laneId} view={quickbooks} /> : null}
          {composio ? <ComposioRows laneId={laneId} view={composio} /> : null}
        </ul>
        {google ? <GoogleNotes /> : null}
        {microsoft ? <MicrosoftNotes view={microsoft} /> : null}
        {quickbooks ? <QuickBooksNotes laneId={laneId} now={now} /> : null}
        {composio ? <ComposioNotes view={composio} /> : null}
        {coverage ? <CoverageList view={coverage} tz={tz} now={now} /> : null}
      </Card>
    </section>
  );
}
