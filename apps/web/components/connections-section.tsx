// Settings -> Connections (T-230 B): one compact list for every provider the user may manage: Google rows (T-199) and
// Composio rows (T-219). Which providers appear is decided by the loaders (owner or admin_technical at AAL2); a provider
// whose view is null is not drawn at all. This component only draws.
import { Card, CardDescription, CardHeader, CardTitle } from "@nichols/ui";
import type { ComposioSectionView } from "@/lib/composio-connection";
import type { GoogleSectionView } from "@/lib/google-connection";
import { ComposioNotes, ComposioNotices, ComposioRows } from "./composio-connection-section";
import { ConnectionsHeader } from "./connection-rows";
import { GoogleNotes, GoogleNotices, GoogleRows } from "./google-connection-section";

export function ConnectionsSection({ laneId, google, composio }: { laneId: string; google: GoogleSectionView | null; composio: ComposioSectionView | null }) {
  return (
    <section id="connections" aria-labelledby="connections-title" className="scroll-mt-8">
      <Card>
        <CardHeader>
          <CardTitle as="h2" id="connections-title">
            Connections
          </CardTitle>
          <CardDescription>The accounts that feed this company&apos;s mail, calendar and files into the portal.</CardDescription>
        </CardHeader>
        {google ? <GoogleNotices view={google} /> : null}
        {composio ? <ComposioNotices view={composio} /> : null}
        <ul data-testid="connections-list" className="flex flex-col divide-y divide-border">
          <ConnectionsHeader />
          {google ? <GoogleRows laneId={laneId} view={google} /> : null}
          {composio ? <ComposioRows laneId={laneId} view={composio} /> : null}
        </ul>
        {google ? <GoogleNotes /> : null}
        {composio ? <ComposioNotes view={composio} /> : null}
      </Card>
    </section>
  );
}
