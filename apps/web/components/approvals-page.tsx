// Approvals (D-20 batch 1, p5 and p7): header with the context line, the "Waiting for you" list and a detail pane.
// The module (T-115) fills both; until then each is an empty state. Nothing here sends or changes anything.
import { PageHeader, PageSection } from "@nichols/ui";
import { loadLane } from "@/lib/lane-page";

export async function ApprovalsPage({ params }: { params: Promise<{ laneId: string }> }) {
  await loadLane((await params).laneId);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Nothing is sent or changed until you approve it" title="Approvals" accent="waiting for you" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <PageSection title="Waiting for you" emptyTitle="Approvals are not set up yet" emptyDescription="Proposed emails and project changes will be listed here." />
        <PageSection title="Details" emptyTitle="Nothing selected" emptyDescription="Select an approval to see exactly what will be sent or changed." />
      </div>
    </div>
  );
}
