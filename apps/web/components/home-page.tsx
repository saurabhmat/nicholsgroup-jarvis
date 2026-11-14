// Home (D-20 batch 1, p3 and p6; T-234 layout; T-237 part C redesign, docs/design/home/*.png). Desktop order: header (greeting, sync status,
// Ask Jarvis), approvals banner (hidden at 0), KPI row, two columns 2:1 (left "Needs your attention"; right Today, then GovCon news),
// the Finance section (md and up only), then the slim Projects card. Phone (below md), in the iPhone design's order: approvals,
// attention, Today, KPIs, news, projects (Finance hidden). One DOM, one render of each section: the phone order is CSS `order`.
// The grid items are placed explicitly from md (row/column starts) so DOM order stays the desktop reading order.
// T-234 part 5: HomeAutoRefresh re-reads this page every 5 minutes with router.refresh() only. A render of this page
// reads stored data and starts nothing: no AI briefing (the summary starts from the client's one call on mount, never from a render), no news fetch (stored digest; Refresh is a button),
// no sync (the sync jobs run in Inngest). Client state (drawer, fields, expanded sections) lives in client components below.
// T-231b: "Needs your attention" shows subject (figures masked), sender and mailbox to callers who may read the lane's mail
// (comms view, AAL2); never a body.
import Link from "next/link";
import { cache, Suspense } from "react";
import { Alert, AlertDescription, AlertTitle, buttonVariants, homeHeading, laneHref, PageHeader, PageSection } from "@nichols/ui";
import { eyebrowDate } from "@/lib/format-date";
import { guards } from "@/lib/guards";
import { cookies } from "next/headers";
import { composeBriefing, homeFor, type HomeView } from "@/lib/home";
import { briefingFor, lastFailureReason, latestBriefing, loadRunState, withSummaryApplied } from "@/lib/briefing";
import { aiSetupFailure } from "@/lib/briefing-setup";
import { adminHint } from "@nichols/briefing/hints";
import { staleDataLine } from "@nichols/briefing/domain";
import { AiBriefing, Deadlines, notesByMessage, repliesByMessage } from "./home-ai-briefing";
import { ReplyDrafts } from "./home-reply-drafts";
import { AttentionSection, CalendarSections } from "./home-briefing";
import { HomeCoverageDot } from "./coverage-dot";
import { JobFailureBanner } from "./job-failure-banner";
import { jobFailureBannerFor } from "@/lib/job-failures";
import { KpiStrip } from "./kpi-strip";
import { GovConNews } from "./home-news";
import { loadNewsCard } from "@/lib/news";
import { ProjectsGlance } from "./home-projects";
import { TimezoneCookie } from "./timezone-cookie";
import { loadLane } from "@/lib/lane-page";
import { firstNameFor } from "@/lib/first-name";
import { HomeFinanceSection } from "./home-finance-section";
import { HomeScope, PersistedDetails } from "./home-scope";
import { HomeAutoRefresh } from "./home-auto-refresh";
import { BriefingAuto } from "./briefing-auto";
import { ApprovalsWaiting } from "./approvals-waiting";
import { OnboardingBanner } from "./onboarding-entry";
import { HomeSkeleton, KpiStripSkeleton } from "./page-skeleton";
import { onboardingFor } from "@/lib/onboarding-progress";
import { timed } from "@/lib/timed";
import { hasFinanceView, homeFinanceFor } from "@/lib/home-finance";
import { homeFinanceDetailFor } from "@/lib/home-finance-detail";
import { kpiTiles, quickbooksStrip } from "@/lib/home-kpi-tiles";
import { freshWindowText } from "@/lib/fresh-window";

/** Home's display zone: always Eastern, never the tz cookie (the cookie is still refreshed for other pages). */
const HOME_TZ = "America/New_York";

export async function HomePage({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const now = new Date();
  // The verified user id (from loadLane's lane check) is only a sessionStorage key part for view state (expanded sections, the open drawer).
  const userId = lane.userId;
  // Home shows every time in America/New_York (T-237 brief), whatever zone the viewer's browser reports.
  const tz = HOME_TZ;
  // The first name is the session user's own profile row (core.users.display_name); none readable: just "Good morning" (never invented).
  // It loads in its own Suspense boundary (HomeGreeting), so the header never waits on it.
  // T-230 A: the header renders as soon as the lane is verified; the data sections and the setup banner stream in behind it
  // (each in its own boundary, so the slow setup lookup never holds back today's figures, and neither holds the header).
  return (
    <HomeScope laneId={lane.laneId} userId={userId}>
    <div className="flex flex-col gap-5">
      <PageHeader
        className="mb-2"
        eyebrow={`${eyebrowDate(now)} · ${lane.name}`}
        title={
          <Suspense fallback={homeHeading(undefined, now).lead}>
            <HomeGreeting laneId={lane.laneId} now={now} />
          </Suspense>
        }
        actions={
          <>
            <HomeAutoRefresh renderedAt={now.toISOString()} tz={tz} />
            <Suspense fallback={null}>
              <HomeCoverageDot laneId={lane.laneId} now={now} />
            </Suspense>
            <Link href={laneHref(lane.laneId, "assistant")} className={buttonVariants()}>
              Ask Jarvis
            </Link>
          </>
        }
      />
      {/* The setup banner is phone-only (md:hidden). Its slot has the banner's own height while it loads, so it never pushes the cards down. */}
      <Suspense fallback={<div aria-hidden data-testid="setup-banner-slot" className={`${BANNER_SLOT} md:hidden`} />}>
        <SetupBanner laneId={lane.laneId} />
      </Suspense>
      <Suspense fallback={null}>
        <ApprovalsWaiting laneId={lane.laneId} />
      </Suspense>
      {/* The grid items are the KPI row (its own boundary) and the sections of HomeSections. From md every item has an explicit
          row/column (see GRID_*), so a hidden item (no approvals, no finance) leaves a zero-height row and no gap (items carry their own bottom margin).
          Phone: one column, `order` classes give the iPhone design's order. */}
      <div data-testid="home-grid" className="grid grid-cols-1 gap-5 md:grid-cols-3 md:grid-rows-[auto_auto_auto_auto_1fr_auto_auto] md:gap-x-5 md:gap-y-0">
        <Suspense fallback={<HomeSkeleton />}>
          <HomeSections laneId={lane.laneId} now={now} />
        </Suspense>
      </div>
    </div>
    </HomeScope>
  );
}

/** The greeting text at once ("Good morning", "Good afternoon" or "Good evening" by Eastern time), with the first name once the profile row is read. */
async function HomeGreeting({ laneId, now }: { laneId: string; now: Date }) {
  const heading = homeHeading(await timed("load.first_name", async () => firstNameFor(await guards(), laneId)), now);
  return (
    <>
      {heading.lead}
      {heading.accent ? (
        <>
          {" "}
          <em data-slot="accent" className="font-normal italic text-accent-italic">
            {heading.accent}
          </em>
        </>
      ) : null}
    </>
  );
}

/** Height of the phone banner (one line plus padding); the Suspense slot above reserves exactly this. */
const BANNER_SLOT = "h-[3.25rem]";

async function SetupBanner({ laneId }: { laneId: string }) {
  return <OnboardingBanner laneId={laneId} progress={await onboardingFor(laneId)} />;
}

async function HomeSections({ laneId, now }: { laneId: string; now: Date }) {
  const tzCookie = (await cookies()).get("tz")?.value;
  const tz = HOME_TZ;
  const g = await guards();
  // Home v1 counts and the T-231 briefing sections load in parallel. Each shows its own "unavailable" state; neither ever shows an empty day.
  const laneClient = async () => (await g.requireLane(laneId as Parameters<typeof g.requireLane>[0])).client;
  const [view, brief, saved, isAdmin, isOwner, newsCard, runState, jobFailures] = await Promise.all([
    timed("load.home", async () => homeFor(g, laneId, now)),
    timed("load.briefing", async () => briefingFor(await laneClient(), laneId, now, tz)),
    timed("load.briefing_latest", async () => latestBriefing(await laneClient(), laneId)),
    g.requireRole(laneId as Parameters<typeof g.requireLane>[0], ["owner", "admin_technical"]).then(() => true, () => false),
    // Reply is a drawer only for the owner (T-234 part 3): it proposes and sends through approvals, which are owner-only.
    g.requireRole(laneId as Parameters<typeof g.requireLane>[0], ["owner"]).then(() => true, () => false),
    // The stored GovCon news digest, read only: a render (or the 5-minute auto-refresh) never starts a fetch (T-234 part 4).
    timed("load.news", async () => {
      const [admin, owner] = await Promise.all([
        g.requireRole(laneId as Parameters<typeof g.requireLane>[0], ["owner", "admin_technical"]).then(() => true, () => false),
        g.requireRole(laneId as Parameters<typeof g.requireLane>[0], ["owner"]).then(() => true, () => false),
      ]);
      return loadNewsCard(await laneClient(), laneId, { isOwner: owner, isAdmin: admin }, now).catch(() => null);
    }),
    // The owner's run state (a run open, the last Regenerate, runs today): SQL answers nothing for anyone else (T-235 part 1).
    timed("load.briefing_run_state", async () => loadRunState(await laneClient(), laneId)),
    // Scheduled functions that failed 3 times in a row (T-238 E): owner and admin_technical only, null for everyone else or when unreadable.
    timed("load.job_failures", () => jobFailureBannerFor(g, laneId)),
  ]);
  // Why there is no AI summary: the AI setup itself (names only), else the stored code of the newest failed attempt.
  const setup = aiSetupFailure();
  const failure = setup?.code ?? (saved && (saved.status === "failed" || saved.lastFailedAt) ? await lastFailureReason(await laneClient(), laneId) : null);
  // The hint is built here, on the server, and only for admins: non-admins get no hint string at all.
  const failureHint = isAdmin && failure ? adminHint(failure, setup?.names ?? []) : null;
  return (
    <>
      <TimezoneCookie current={tzCookie ?? null} />
      {view.unavailable || jobFailures ? (
        <div data-testid="home-alerts-slot" className={`${GRID_FULL} flex flex-col gap-3 md:row-start-1 md:mb-5`}>
          <JobFailureBanner laneId={laneId} items={jobFailures} now={now} />
          {view.unavailable ? (
            <Alert variant="alert">
              <AlertTitle>Some of today&apos;s information could not be loaded</AlertTitle>
              <AlertDescription>Reload the page in a minute. If it keeps happening, check Settings → Connections.</AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}
      {/* KPI row: directly under the approvals banner on desktop, after Today on the phone. Its own boundary: a slow QuickBooks read never holds the rest back. */}
      <div data-testid="home-kpi-slot" className={`${GRID_FULL} order-3 min-w-0 empty:hidden md:order-none md:row-start-2 md:mb-5`}>
        <Suspense fallback={<KpiStripSkeleton />}>
          <KpiSection laneId={laneId} feeds={view.feeds} canConnect={isAdmin} />
        </Suspense>
      </div>
      <div data-testid="home-attention-slot" className="order-1 flex min-w-0 flex-col gap-5 md:order-none md:col-span-2 md:col-start-1 md:row-span-3 md:row-start-3 md:mb-5">
        <PageSection title="Needs your attention" note={`Top 5 from the last ${freshWindowText(brief.config.attention.fresh_hours)}`}>
          <AiBriefing laneId={laneId} brief={saved} fallbackLines={view.unavailable ? [] : composeBriefing(view, now)} tz={brief.viewerTz} controls={isOwner && brief.mail.access ? <BriefingAuto laneId={laneId} preparedAt={saved && saved.status !== "failed" ? saved.preparedAt : null} initial={runState} tz={brief.viewerTz} /> : null} now={now} failure={failure} failureHint={failureHint} staleLine={brief.unavailable ? null : staleDataLine(brief.coverage, now, saved && saved.status !== "failed" ? saved.preparedAt : null)} />
          <AttentionSection laneId={laneId} mail={withSummaryApplied(brief.mail, saved)} now={now} notes={notesByMessage(saved)} replies={repliesByMessage(saved)} canReply={isOwner} tz={brief.viewerTz} />
          {saved && saved.status !== "failed" ? (
            // Folded so the card stays short: reply drafts (with Copy) and deadlines from the briefing.
            <PersistedDetails id="attention-extras" testId="attention-extras" className="border-t border-border pt-3" summaryClassName="cursor-pointer text-small font-medium text-primary" summary="Drafts and deadlines">
              <div className="mt-3 flex flex-col gap-5">
                <ReplyDrafts laneId={laneId} brief={saved} tz={brief.viewerTz} />
                <Deadlines laneId={laneId} brief={saved} tz={brief.viewerTz} />
              </div>
            </PersistedDetails>
          ) : null}
        </PageSection>
      </div>
      <div data-testid="home-calendar-slot" className="order-2 flex min-w-0 flex-col gap-5 md:order-none md:col-start-3 md:row-start-3 md:mb-5">
        <CalendarSections view={brief} now={now} />
      </div>
      <div data-testid="home-news-slot" className="order-4 min-w-0 md:order-none md:col-start-3 md:row-start-4 md:mb-5">
        <GovConNews laneId={laneId} card={newsCard} tz={brief.viewerTz} now={now} />
      </div>
      {/* Finance: md and up only (the iPhone design omits it); hidden entirely when QuickBooks is not connected or for no_access. */}
      <div data-testid="home-finance-slot" className={`${GRID_FULL} hidden min-w-0 empty:hidden md:row-start-6 md:mb-5 md:block`}>
        <Suspense fallback={null}>
          <FinanceSlot laneId={laneId} />
        </Suspense>
      </div>
      <div data-testid="home-projects-slot" className={`${GRID_FULL} order-5 min-w-0 md:order-none md:row-start-7`}>
        <ProjectsGlance laneId={laneId} canConnect={isAdmin} />
      </div>
    </>
  );
}

const GRID_FULL = "md:col-span-3 md:col-start-1";

/** Both finance reads, once per request (React `cache`): the KPI row and the Finance section share them. */
const loadFinance = cache(async (laneId: string) => {
  const g = await guards();
  const [finance, detail] = await Promise.all([timed("load.home_finance", async () => homeFinanceFor(g, laneId)), timed("load.home_finance_detail", async () => homeFinanceDetailFor(g, laneId))]);
  // An outage is shown only to a caller who holds the lane's finance view; anyone else sees no finance UI at all (the check runs only during an outage).
  if ((finance.state === "unavailable" || detail.state === "unavailable") && !(await hasFinanceView(g, laneId))) {
    return [finance.state === "unavailable" ? ({ state: "no_access" } as const) : finance, detail.state === "unavailable" ? ({ state: "no_access" } as const) : detail] as const;
  }
  return [finance, detail] as const;
});

async function KpiSection({ laneId, feeds, canConnect }: { laneId: string; feeds: HomeView["feeds"]; canConnect: boolean }) {
  const [finance, detail] = await loadFinance(laneId);
  return <KpiStrip laneId={laneId} tiles={kpiTiles(finance, detail, feeds)} strip={quickbooksStrip(finance, canConnect)} />;
}

async function FinanceSlot({ laneId }: { laneId: string }) {
  const [finance, detail] = await loadFinance(laneId);
  return <HomeFinanceSection laneId={laneId} finance={finance} detail={detail} />;
}
