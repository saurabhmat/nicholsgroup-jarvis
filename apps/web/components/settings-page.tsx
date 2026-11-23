// Settings (T-023 placeholder), the connect result banner, Connections (Google T-199, QuickBooks T-233 and Composio T-219 rows) and AI brain, in two columns with a sub-nav (T-230 B). The lane
// gate runs first, as on every page; the connection rows are shown only to owner or admin_technical at AAL2, and the
// routes behind their buttons enforce the same on their own (this only decides what is drawn).
import { approvalsDeps } from "@nichols/approvals/wire";
import { Alert, AlertDescription, AlertTitle } from "@nichols/ui";
import { connectResultFor } from "@/lib/connect-result";
import { loadLane } from "@/lib/lane-page";
import { laneGate } from "@/lib/lane-modules";
import { guards } from "@/lib/guards";
import { quickbooksSectionFor } from "@/lib/quickbooks-connection";
import { googleSectionFor } from "@/lib/google-connection";
import { mailProvidersFor } from "@/lib/mail-providers";
import { microsoftSectionFor } from "@/lib/microsoft-connection";
import { availability, missingSettings } from "@/lib/composio-availability";
import { composioSectionFor } from "@/lib/composio-connection";
import { ConnectionsSection } from "./connections-section";
import { SettingsNav, type SettingsNavItem } from "./settings-nav";
import { currentOriginNotice } from "@/lib/origin-notice-server";
import { onboardingFor } from "@/lib/onboarding-progress";
import { coverageFor } from "@/lib/coverage";
import { viewerZone } from "@/lib/briefing";
import { cookies } from "next/headers";
import { timed } from "@/lib/timed";
import { BrainSection } from "./brain-section";
import { NewsSection } from "./news-section";
import { newsSectionFor } from "@/lib/news-settings";
import { jobFailureBannerFor } from "@/lib/job-failures";
import { ModulePage } from "./module-page";
import { SettingsPagesSection, settingsPagesTitle } from "./settings-pages-section";

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
  const now = new Date();
  const tz = viewerZone((await cookies()).get("tz")?.value);
  // T-257: ONE read of the company's enabled providers per render, shared by the Google and the Microsoft section.
  const providers = timed("load.mail_providers", () => mailProvidersFor(g, lane.laneId));
  const microsoftP = timed("load.microsoft", async () => microsoftSectionFor(g, lane.laneId, await providers));
  // T-265: which sections this company uses (finance = the QuickBooks row, brain = AI brain, news = GovCon news). One read, shared with the layout.
  const gate = await laneGate(lane.laneId);
  const [result, quickbooks, google, microsoft, composio, brain, coverage, news, jobFailures] = await Promise.all([
    // The result of a connect the OAuth callback sent back here (fixed, allowlisted text; connect roles only).
    timed("load.connect_result", async () => {
      const section = await microsoftP; // the banner's Microsoft wording follows the same scope list as the section; consent returns show only where Microsoft is enabled
      return connectResultFor(g, lane.laneId, query, { enabled: Boolean(section && !section.paused && !section.unavailable && !section.settingsUnknown), writes: section?.writes ?? null });
    }),
    timed("load.quickbooks", async () => (gate.visible("finance") ? quickbooksSectionFor(g, lane.laneId, undefined, approvalsDeps) : null)),
    timed("load.google", async () => googleSectionFor(g, lane.laneId, undefined, await providers)),
    microsoftP,
    timed("load.composio", async () => {
      const view = await composioSectionFor(g, lane.laneId, availability, undefined, missingSettings);
      // Composio carries Gmail and Google Calendar only: a company without Google enabled and with no Composio account shows no row for it.
      const p = await providers;
      return view && p?.state === "known" && !p.google && view.toolkits.every((t) => t.connection === null) ? null : view;
    }),
    gate.visible("brain") ? onboardingFor(lane.laneId) : Promise.resolve(null), // null unless the owner has the brain view here
    // Coverage per source (T-234; it was a card on Home). The SQL answers only for callers with the comms or calendar view.
    timed("load.coverage", () => coverageFor(g, lane.laneId, now)),
    // GovCon news status (T-234 part 4): owner and admin_technical only; null for everyone else.
    timed("load.news_settings", async () => (gate.newsShown ? newsSectionFor(g, lane.laneId) : null)),
    // Scheduled functions that failed 3 times in a row (T-238 E): owner and admin_technical only.
    timed("load.job_failures", () => jobFailureBannerFor(g, lane.laneId)),
  ]);
  // On another host than NEXT_PUBLIC_APP_URL a connect cannot finish (hosts only in the notice); only users who can connect see it.
  const origin = google || microsoft || quickbooks || composio ? await currentOriginNotice() : null;
  // The "not set up yet" card only stands in for a page with nothing real on it.
  const showCoverage = coverage.unavailable || coverage.items.length > 0;
  // T-271: Approvals and Assistant have no side menu entry; they are opened from here (a company that hides the module shows no link).
  const pages = (["approvals", "assistant"] as const).filter((m) => gate.visible(m));
  const anySection = Boolean(result || google || microsoft || quickbooks || composio || brain || showCoverage || news || pages.length > 0);
  // The sub-nav lists exactly the sections that are drawn below (the loaders above decide who sees which).
  const nav: SettingsNavItem[] = [
    ...(pages.length > 0 ? [{ id: "pages", label: settingsPagesTitle(pages) }] : []),
    ...(google || microsoft || quickbooks || composio || showCoverage ? [{ id: "connections", label: "Connections" }] : []),
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
            <SettingsPagesSection laneId={lane.laneId} pages={pages} />
            {google || microsoft || quickbooks || composio || showCoverage ? <ConnectionsSection laneId={lane.laneId} google={google} microsoft={microsoft} quickbooks={quickbooks} composio={composio} coverage={showCoverage ? coverage : null} jobFailures={jobFailures} tz={tz} now={now} /> : null}
            {news ? <NewsSection view={news} tz={tz} now={now} /> : null}
            {brain ? <BrainSection laneId={lane.laneId} view={brain} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
