// Settings (T-023 placeholder), the connect result banner, Connections (Google T-199, QuickBooks T-233 and Composio T-219 rows) and AI brain, in two columns with a sub-nav (T-230 B). The lane
// gate runs first, as on every page; the connection rows are shown only to owner or admin_technical at AAL2, and the
// routes behind their buttons enforce the same on their own (this only decides what is drawn).
import { MAIL_CONNECT_ROLES } from "@nichols/connectors/oauth";
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
import { ModulePage, ModulePlaceholder } from "./module-page";
import { CardSkeleton } from "./page-skeleton";
import { Suspense } from "react";
import type { LaneGate } from "@/lib/lane-modules";
import { SettingsPagesSection, settingsPagesTitle } from "./settings-pages-section";

// T-276: the page used to wait for its longest chain (the AI brain status, about 6 levels) before showing anything. Now the header and a neutral card show at
// once and the sections stream in, each in its own boundary. Every loader still starts at the same moment, with the one guards object, and keeps its own
// role check. The sub-navigation is decided from the cheap answers (the company's module list and the two role answers, which the loaders also share),
// never from the slow loads, so it does not wait for them and a section is never listed that its role cannot have.

type Sections = {
  gate: Promise<LaneGate>;
  admin: Promise<boolean>;
  /** The roles that may see the Google and Microsoft account rows (owner, admin_technical, viewer: the loaders ask the same question, so the guards share the answer). */
  mailConnect: Promise<boolean>;
  owner: Promise<boolean>;
  result: Promise<Awaited<ReturnType<typeof connectResultFor>>>;
  quickbooks: Promise<Awaited<ReturnType<typeof quickbooksSectionFor>> | null>;
  google: Promise<Awaited<ReturnType<typeof googleSectionFor>>>;
  microsoft: Promise<Awaited<ReturnType<typeof microsoftSectionFor>>>;
  composio: Promise<Awaited<ReturnType<typeof composioSectionFor>> | null>;
  brain: Promise<Awaited<ReturnType<typeof onboardingFor>> | null>;
  coverage: Promise<Awaited<ReturnType<typeof coverageFor>>>;
  news: Promise<Awaited<ReturnType<typeof newsSectionFor>> | null>;
  jobFailures: Promise<Awaited<ReturnType<typeof jobFailureBannerFor>>>;
};

/** Marks a started read as handled (the sections that await it still see its failure); a read nobody awaits, because the render ended, is never an unhandled rejection. */
function started<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined);
  return p;
}

export async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ laneId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const lane = await loadLane((await params).laneId); // the lane gate first, as on every page
  const laneId = lane.laneId;
  const g = await guards(); // one per request (lib/guards.ts): the loaders below share its session, lane and role answers
  const query = await searchParams;
  const now = new Date();
  const tz = viewerZone((await cookies()).get("tz")?.value);
  type Lane = Parameters<typeof g.requireLane>[0];
  // Independent reads, all started now (T-230 A). Each keeps its own role check; the guards memoise the shared ones.
  // T-257: ONE read of the company's enabled providers per render, shared by the Google and the Microsoft section.
  const providers = started(timed("load.mail_providers", () => mailProvidersFor(g, laneId)));
  const microsoft = started(timed("load.microsoft", async () => microsoftSectionFor(g, laneId, await providers)));
  // T-265: which sections this company uses (finance = the QuickBooks row, brain = AI brain, news = GovCon news). One read, shared with the layout.
  const gate = started(laneGate(laneId));
  const sections: Sections = {
    gate,
    admin: started(g.requireRole(laneId as Lane, ["owner", "admin_technical"]).then(() => true, () => false)),
    mailConnect: started(g.requireRole(laneId as Lane, [...MAIL_CONNECT_ROLES]).then(() => true, () => false)),
    owner: started(g.requireRole(laneId as Lane, ["owner"]).then(() => true, () => false)),
    // The result of a connect the OAuth callback sent back here (fixed, allowlisted text; connect roles only).
    result: started(
      timed("load.connect_result", async () => {
        const section = await microsoft; // the banner's Microsoft wording follows the same scope list as the section; consent returns show only where Microsoft is enabled
        return connectResultFor(g, laneId, query, { enabled: Boolean(section && !section.paused && !section.unavailable && !section.settingsUnknown), writes: section?.writes ?? null });
      }),
    ),
    quickbooks: started(timed("load.quickbooks", async () => ((await gate).visible("finance") ? quickbooksSectionFor(g, laneId, undefined, approvalsDeps) : null))),
    google: started(timed("load.google", async () => googleSectionFor(g, laneId, undefined, await providers))),
    microsoft,
    composio: started(
      timed("load.composio", async () => {
        const view = await composioSectionFor(g, laneId, availability, undefined, missingSettings);
        // Composio carries Gmail and Google Calendar only: a company without Google enabled and with no Composio account shows no row for it.
        const p = await providers;
        return view && p?.state === "known" && !p.google && view.toolkits.every((t) => t.connection === null) ? null : view;
      }),
    ),
    brain: started((async () => ((await gate).visible("brain") ? onboardingFor(laneId) : null))()), // null unless the owner has the brain view here
    // Coverage per source (T-234; it was a card on Home). The SQL answers only for callers with the comms or calendar view.
    coverage: started(timed("load.coverage", () => coverageFor(g, laneId, now))),
    // GovCon news status (T-234 part 4): owner and admin_technical only; null for everyone else.
    news: started(timed("load.news_settings", async () => ((await gate).newsShown ? newsSectionFor(g, laneId) : null))),
    // Scheduled functions that failed 3 times in a row (T-238 E): owner and admin_technical only.
    jobFailures: started(timed("load.job_failures", () => jobFailureBannerFor(g, laneId))),
  };
  return (
    <div className="flex flex-col gap-4">
      <ModulePage module="settings" params={params} placeholder={false} />
      <Suspense fallback={<CardSkeleton />}>
        <SettingsBody laneId={laneId} sections={sections} tz={tz} now={now} />
      </Suspense>
    </div>
  );
}

/** The sub-navigation and the section slots. Waits only for the module list and the role answers (and, for someone who is not an administrator, the Coverage answer that decides whether Connections exists for them). */
async function SettingsBody({ laneId, sections, tz, now }: { laneId: string; sections: Sections; tz: string; now: Date }) {
  const [gate, isAdmin, canSeeAccounts, isOwner] = await Promise.all([sections.gate, sections.admin, sections.mailConnect, sections.owner]);
  // T-271: Approvals and Assistant have no side menu entry; they are opened from here (a company that hides the module shows no link).
  const pages = (["approvals", "assistant"] as const).filter((m) => gate.visible(m));
  // Connections: the account rows are for the roles above (their loaders return nothing for anyone else); Coverage is the one part other roles can have.
  const coverage = canSeeAccounts ? null : await sections.coverage;
  const connections = canSeeAccounts || Boolean(coverage && (coverage.unavailable || coverage.items.length > 0));
  const news = isAdmin && gate.newsShown;
  const brain = isOwner && gate.visible("brain");
  // The sub-nav lists exactly the sections that are drawn below.
  const nav: SettingsNavItem[] = [
    ...(pages.length > 0 ? [{ id: "pages", label: settingsPagesTitle(pages) }] : []),
    ...(connections ? [{ id: "connections", label: "Connections" }] : []),
    ...(news ? [{ id: "news", label: "GovCon news" }] : []),
    ...(brain ? [{ id: "ai-brain", label: "AI brain" }] : []),
  ];
  return (
    <>
      <Suspense fallback={null}>
        <Notices sections={sections} />
      </Suspense>
      {nav.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
          <SettingsNav items={nav} />
          <div className="flex min-w-0 flex-col gap-4">
            <SettingsPagesSection laneId={laneId} pages={pages} />
            {connections ? (
              <Suspense fallback={<CardSkeleton />}>
                <ConnectionsSlot laneId={laneId} sections={sections} tz={tz} now={now} />
              </Suspense>
            ) : null}
            {news ? (
              <Suspense fallback={<CardSkeleton />}>
                <NewsSlot sections={sections} tz={tz} now={now} />
              </Suspense>
            ) : null}
            {brain ? (
              <Suspense fallback={<CardSkeleton />}>
                <BrainSlot laneId={laneId} sections={sections} />
              </Suspense>
            ) : null}
          </div>
        </div>
      ) : (
        // The "not set up yet" card only stands in for a page with nothing real on it (no section can be drawn for this viewer).
        <ModulePlaceholder module="settings" />
      )}
    </>
  );
}

/** The connect result and the origin notice (hosts only; only for users who can connect). */
async function Notices({ sections }: { sections: Sections }) {
  const [result, google, microsoft, quickbooks, composio] = await Promise.all([sections.result, sections.google, sections.microsoft, sections.quickbooks, sections.composio]);
  // On another host than NEXT_PUBLIC_APP_URL a connect cannot finish (hosts only in the notice); only users who can connect see it.
  const origin = google || microsoft || quickbooks || composio ? await currentOriginNotice() : null;
  return (
    <>
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
    </>
  );
}

async function ConnectionsSlot({ laneId, sections, tz, now }: { laneId: string; sections: Sections; tz: string; now: Date }) {
  const [google, microsoft, quickbooks, composio, coverage, jobFailures] = await Promise.all([sections.google, sections.microsoft, sections.quickbooks, sections.composio, sections.coverage, sections.jobFailures]);
  // The "not set up yet" card is not for this slot: a viewer with no provider row and no coverage row simply has no Connections section.
  const showCoverage = coverage.unavailable || coverage.items.length > 0;
  if (!(google || microsoft || quickbooks || composio || showCoverage)) return null;
  return <ConnectionsSection laneId={laneId} google={google} microsoft={microsoft} quickbooks={quickbooks} composio={composio} coverage={showCoverage ? coverage : null} jobFailures={jobFailures} tz={tz} now={now} />;
}

async function NewsSlot({ sections, tz, now }: { sections: Sections; tz: string; now: Date }) {
  const news = await sections.news;
  return news ? <NewsSection view={news} tz={tz} now={now} /> : null;
}

async function BrainSlot({ laneId, sections }: { laneId: string; sections: Sections }) {
  const brain = await sections.brain;
  return brain ? <BrainSection laneId={laneId} view={brain} /> : null;
}
