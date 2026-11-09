// Settings (T-023 placeholder), the connect result banner, Connections (Google T-199 and Composio T-219 rows), AI brain, and Developer tools (the temporary QuickBooks connection test, T-198), in two columns with a sub-nav (T-230 B). The lane gate runs first, as on
// every page; the test section is shown only to owner or admin_technical at AAL2 when the lane switched it on, and the
// check route enforces the same on its own (this only decides what is drawn).
import { Alert, AlertDescription, AlertTitle } from "@nichols/ui";
import { connectResultFor } from "@/lib/connect-result";
import { loadLane } from "@/lib/lane-page";
import { guards } from "@/lib/guards";
import { connectionTestVisible } from "@/lib/connection-test";
import { googleSectionFor } from "@/lib/google-connection";
import { availability, missingSettings } from "@/lib/composio-availability";
import { composioSectionFor } from "@/lib/composio-connection";
import { ConnectionsSection } from "./connections-section";
import { ConnectionTestSection } from "./connection-test-section";
import { SettingsNav, type SettingsNavItem } from "./settings-nav";
import { currentOriginNotice } from "@/lib/origin-notice-server";
import { onboardingFor } from "@/lib/onboarding-progress";
import { timed } from "@/lib/timed";
import { BrainSection } from "./brain-section";
import { ModulePage } from "./module-page";

export async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ laneId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const lane = await loadLane((await params).laneId); // the lane gate first, as on every page
  const g = await guards(); // one per request (lib/guards.ts): the loaders below share its session, lane and role answers
  const query = await searchParams;
  // Independent reads, run together (T-230 A). Each keeps its own role check; the guards memoise the shared ones.
  const [result, showTest, google, composio, brain] = await Promise.all([
    // The result of a connect the OAuth callback sent back here (fixed, allowlisted text; connect roles only).
    timed("load.connect_result", () => connectResultFor(g, lane.laneId, query)),
    timed("load.connection_test", () => connectionTestVisible(g, lane.laneId)),
    timed("load.google", () => googleSectionFor(g, lane.laneId)),
    timed("load.composio", () => composioSectionFor(g, lane.laneId, availability, undefined, missingSettings)),
    onboardingFor(lane.laneId), // null unless the owner has the brain view here
  ]);
  // On another host than NEXT_PUBLIC_APP_URL a connect cannot finish (hosts only in the notice); only users who can connect see it.
  const origin = google || composio ? await currentOriginNotice() : null;
  // The "not set up yet" card only stands in for a page with nothing real on it.
  const anySection = Boolean(result || google || composio || brain || showTest);
  // The sub-nav lists exactly the sections that are drawn below (the loaders above decide who sees which).
  const nav: SettingsNavItem[] = [
    ...(google || composio ? [{ id: "connections", label: "Connections" }] : []),
    ...(brain ? [{ id: "ai-brain", label: "AI brain" }] : []),
    ...(showTest ? [{ id: "developer-tools", label: "Developer tools" }] : []),
  ];
  return (
    <div className="flex flex-col gap-4">
      <ModulePage module="settings" params={params} placeholder={!anySection} />
      {result ? (
        <Alert variant={result.tone} data-testid="connect-result">
          <AlertTitle>{result.title}</AlertTitle>
          <AlertDescription>{result.description}</AlertDescription>
        </Alert>
      ) : null}
      {origin ? (
        <Alert data-testid="origin-notice">
          <AlertDescription>
            You&apos;re on {origin.currentHost}. Open{" "}
            <a href={origin.appUrl} className="font-medium underline">
              {origin.appHost}
            </a>{" "}
            to connect accounts.
          </AlertDescription>
        </Alert>
      ) : null}
      {nav.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
          <SettingsNav items={nav} />
          <div className="flex min-w-0 flex-col gap-4">
            {google || composio ? <ConnectionsSection laneId={lane.laneId} google={google} composio={composio} /> : null}
            {brain ? <BrainSection laneId={lane.laneId} view={brain} /> : null}
            {showTest ? <ConnectionTestSection laneId={lane.laneId} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
