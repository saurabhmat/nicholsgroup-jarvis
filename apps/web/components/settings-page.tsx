// Settings (T-023 placeholder), the connect result banner, Connections (Google T-199, QuickBooks T-233 and Composio T-219 rows) and AI brain, in two columns with a sub-nav (T-230 B). The lane
// gate runs first, as on every page; the connection rows are shown only to owner or admin_technical at AAL2, and the
// routes behind their buttons enforce the same on their own (this only decides what is drawn).
import { approvalsDeps } from "@nichols/approvals/wire";
import { Alert, AlertDescription, AlertTitle } from "@nichols/ui";
import { connectResultFor } from "@/lib/connect-result";
import { loadLane } from "@/lib/lane-page";
import { guards } from "@/lib/guards";
import { quickbooksSectionFor } from "@/lib/quickbooks-connection";
import { googleSectionFor } from "@/lib/google-connection";
import { availability, missingSettings } from "@/lib/composio-availability";
import { composioSectionFor } from "@/lib/composio-connection";
import { ConnectionsSection } from "./connections-section";
import { SettingsNav, type SettingsNavItem } from "./settings-nav";
import { currentOriginNotice } from "@/lib/origin-notice-server";
import { onboardingFor } from "@/lib/onboarding-progress";
import { coverageFor } from "@/lib/coverage";
import { viewerZone } from "@/lib/briefing";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { timed } from "@/lib/timed";
import { BrainSection } from "./brain-section";
import { NewsSection } from "./news-section";
import { newsSectionFor } from "@/lib/news-settings";
import { jobFailureBannerFor } from "@/lib/job-failures";
import { ModulePage } from "./module-page";

export async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ laneId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // T-243: a dynamic point before anything can read the clock (see HomePage): with cacheComponents + partialPrefetching a clock read ahead of
  // the request's dynamic data is reported as a prerender error for this route.
  await connection();
  const lane = await loadLane((await params).laneId); // the lane gate first, as on every page
  const g = await guards(); // one per request (lib/guards.ts): the loaders below share its session, lane and role answers
  const query = await searchParams;
  // Independent reads, run together (T-230 A). Each keeps its own role check; the guards memoise the shared ones.
  const now = new Date();
  const tz = viewerZone((await cookies()).get("tz")?.value);
  const [result, quickbooks, google, composio, brain, coverage, news, jobFailures] = await Promise.all([
    // The result of a connect the OAuth callback sent back here (fixed, allowlisted text; connect roles only).
    timed("load.connect_result", () => connectResultFor(g, lane.laneId, query)),
    timed("load.quickbooks", () => quickbooksSectionFor(g, lane.laneId, undefined, approvalsDeps)),
    timed("load.google", () => googleSectionFor(g, lane.laneId)),
    timed("load.composio", () => composioSectionFor(g, lane.laneId, availability, undefined, missingSettings)),
    onboardingFor(lane.laneId), // null unless the owner has the brain view here
    // Coverage per source (T-234; it was a card on Home). The SQL answers only for callers with the comms or calendar view.
    timed("load.coverage", () => coverageFor(g, lane.laneId, now)),
    // GovCon news status (T-234 part 4): owner and admin_technical only; null for everyone else.
    timed("load.news_settings", () => newsSectionFor(g, lane.laneId)),
    // Scheduled functions that failed 3 times in a row (T-238 E): owner and admin_technical only.
    timed("load.job_failures", () => jobFailureBannerFor(g, lane.laneId)),
  ]);
  // On another host than NEXT_PUBLIC_APP_URL a connect cannot finish (hosts only in the notice); only users who can connect see it.
  const origin = google || quickbooks || composio ? await currentOriginNotice() : null;
  // The "not set up yet" card only stands in for a page with nothing real on it.
  const showCoverage = coverage.unavailable || coverage.items.length > 0;
  const anySection = Boolean(result || google || quickbooks || composio || brain || showCoverage || news);
  // The sub-nav lists exactly the sections that are drawn below (the loaders above decide who sees which).
  const nav: SettingsNavItem[] = [
    ...(google || quickbooks || composio || showCoverage ? [{ id: "connections", label: "Connections" }] : []),
    ...(news ? [{ id: "news", label: "GovCon news" }] : []),
    ...(brain ? [{ id: "ai-brain", label: "AI brain" }] : []),
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
            {google || quickbooks || composio || showCoverage ? <ConnectionsSection laneId={lane.laneId} google={google} quickbooks={quickbooks} composio={composio} coverage={showCoverage ? coverage : null} jobFailures={jobFailures} tz={tz} now={now} /> : null}
            {news ? <NewsSection view={news} tz={tz} now={now} /> : null}
            {brain ? <BrainSection laneId={lane.laneId} view={brain} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
