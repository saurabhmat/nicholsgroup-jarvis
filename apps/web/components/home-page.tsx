// Home (D-20 batch 1, p3 and p6; T-234 part 1 layout, on the T-230 tokens). Three aligned rows:
//   1. "Needs your attention" (2/3; T-234 part 2: AI summary + Top 3, top 5 items with Reply/Open, drafts and deadlines folded) |
//      right column: Today's calendar with "Next 7 days" collapsed below it.
//   2. KPI strip: five equal compact tiles (Cash book balance, AR > 30 days, P&L MTD, MRR, Paid subscribers).
//   3. GovCon news (2/3; the stored digest, read only) | Projects at a glance (1/3). Both are SLIM one-line cards (1/2 + 1/2) while
//      the news is off and no board is connected (T-235 part 5). The grid gap is 20px (gap-5), the one off-scale value, by design.
// T-234 part 5: HomeAutoRefresh (header) re-reads this page every 5 minutes with router.refresh() only. A render of this page
// reads stored data and starts nothing: no AI briefing (the summary starts from the client's one call on mount, never from a render), no news fetch (stored digest; Refresh is a button),
// no sync (the sync jobs run in Inngest). Client state (drawer, fields, expanded sections) lives in client components below.
// One column on a phone, in the same order: attention, calendar, KPIs, news, projects. Coverage is no longer a card here: a
// small status dot in the header shows only when a source is stale or in error and links to Settings -> Connections.
// T-231b: "Needs your attention" shows subject (figures masked), sender and mailbox to callers who may read the lane's mail
// (comms view, AAL2); never a body.
import Link from "next/link";
import { Suspense } from "react";
import { Alert, AlertDescription, AlertTitle, buttonVariants, homeHeading, laneHref, PageHeader, PageSection } from "@nichols/ui";
import { eyebrowDate } from "@/lib/format-date";
import { guards } from "@/lib/guards";
import { cookies } from "next/headers";
import { composeBriefing, homeFor, type HomeView } from "@/lib/home";
import { briefingFor, lastFailureReason, latestBriefing, loadRunState, viewerZone } from "@/lib/briefing";
import { aiSetupFailure } from "@/lib/briefing-setup";
import { adminHint } from "@nichols/briefing/hints";
import { AiBriefing, Deadlines, notesByMessage, repliesByMessage } from "./home-ai-briefing";
import { ReplyDrafts } from "./home-reply-drafts";
import { AttentionSection, CalendarSections } from "./home-briefing";
import { HomeCoverageDot } from "./coverage-dot";
import { KpiStrip } from "./kpi-strip";
import { GovConNews } from "./home-news";
import { loadNewsCard } from "@/lib/news";
import { ProjectsGlance } from "./home-projects";
import { TimezoneCookie } from "./timezone-cookie";
import { loadLane } from "@/lib/lane-page";
import { HomeScope, PersistedDetails } from "./home-scope";
import { HomeAutoRefresh } from "./home-auto-refresh";
import { BriefingAuto } from "./briefing-auto";
import { ApprovalsWaiting } from "./approvals-waiting";
import { OnboardingBanner } from "./onboarding-entry";
import { HomeSkeleton, KpiStripSkeleton } from "./page-skeleton";
import { onboardingFor } from "@/lib/onboarding-progress";
import { timed } from "@/lib/timed";
import { homeFinanceFor } from "@/lib/home-finance";
import { kpiTiles } from "@/lib/home-kpi-tiles";

export async function HomePage({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const now = new Date();
  // The verified user id (from loadLane's lane check) is only a sessionStorage key part for view state (expanded sections, the open drawer).
  const userId = lane.userId;
  const tz = viewerZone((await cookies()).get("tz")?.value);
  const heading = homeHeading(); // no first name in the session yet: "Good morning"
  // T-230 A: the header renders as soon as the lane is verified; the data sections and the setup banner stream in behind it
  // (each in its own boundary, so the slow setup lookup never holds back today's figures, and neither holds the header).
  return (
    <HomeScope laneId={lane.laneId} userId={userId}>
    <div className="flex flex-col gap-5">
      <PageHeader
        className="mb-2"
        eyebrow={`${eyebrowDate(now)} · ${lane.name}`}
        title={heading.lead}
        accent={heading.accent}
        actions={
          <>
            <HomeAutoRefresh renderedAt={now.toISOString()} tz={tz} />
            <Suspense fallback={null}>
              <HomeCoverageDot laneId={lane.laneId} />
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
      <Suspense fallback={<HomeSkeleton />}>
        <HomeSections laneId={lane.laneId} now={now} />
      </Suspense>
    </div>
    </HomeScope>
  );
}

/** Height of the phone banner (one line plus padding); the Suspense slot above reserves exactly this. */
const BANNER_SLOT = "h-[3.25rem]";

async function SetupBanner({ laneId }: { laneId: string }) {
  return <OnboardingBanner laneId={laneId} progress={await onboardingFor(laneId)} />;
}

async function HomeSections({ laneId, now }: { laneId: string; now: Date }) {
  const tzCookie = (await cookies()).get("tz")?.value;
  const tz = viewerZone(tzCookie);
  const g = await guards();
  // Home v1 counts and the T-231 briefing sections load in parallel. Each shows its own "unavailable" state; neither ever shows an empty day.
  const laneClient = async () => (await g.requireLane(laneId as Parameters<typeof g.requireLane>[0])).client;
  const [view, brief, saved, isAdmin, isOwner, newsCard, runState] = await Promise.all([
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
  ]);
  // Why there is no AI summary: the AI setup itself (names only), else the stored code of the newest failed attempt.
  const setup = aiSetupFailure();
  const failure = setup?.code ?? (saved && (saved.status === "failed" || saved.lastFailedAt) ? await lastFailureReason(await laneClient(), laneId) : null);
  // The hint is built here, on the server, and only for admins: non-admins get no hint string at all.
  const failureHint = isAdmin && failure ? adminHint(failure, setup?.names ?? []) : null;
  const newsSlim = newsCard?.configured !== true;
  return (
    <>
      <TimezoneCookie current={tzCookie ?? null} />
      {view.unavailable ? (
        <Alert variant="alert">
          <AlertTitle>Some of today&apos;s information could not be loaded</AlertTitle>
          <AlertDescription>Reload the page in a minute. If it keeps happening, check Settings → Connections.</AlertDescription>
        </Alert>
      ) : null}
      {/* Row 1 */}
      <div data-testid="home-row-attention" className="grid items-start gap-5 lg:grid-cols-3">
        <div data-testid="home-attention-slot" className="flex min-w-0 flex-col gap-5 lg:col-span-2">
          <PageSection title="Needs your attention" note="Top 5 · metadata only">
            <AiBriefing laneId={laneId} brief={saved} fallbackLines={view.unavailable ? [] : composeBriefing(view, now)} tz={brief.viewerTz} controls={isOwner && brief.mail.access ? <BriefingAuto laneId={laneId} preparedAt={saved && saved.status !== "failed" ? saved.preparedAt : null} initial={runState} tz={brief.viewerTz} /> : null} now={now} failure={failure} failureHint={failureHint} />
            <AttentionSection laneId={laneId} mail={brief.mail} now={now} notes={notesByMessage(saved)} replies={repliesByMessage(saved)} canReply={isOwner} />
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
        <div data-testid="home-calendar-slot" className="flex min-w-0 flex-col gap-5">
          <CalendarSections view={brief} now={now} />
        </div>
      </div>
      {/* Row 2 */}
      <Suspense fallback={<KpiStripSkeleton />}>
        <KpiSection laneId={laneId} feeds={view.feeds} canConnect={isAdmin} />
      </Suspense>
      {/* Row 3 */}
      {/* Projects has no board yet, so it is always a slim card. With GovCon news also slim, the two sit side by side
          (1/2 + 1/2); with real news, news is 2/3 and the slim Projects card sits in the 1/3 column, at the top. */}
      <div data-testid="home-row-news" data-news-slim={newsSlim ? "true" : "false"} className={`grid items-start gap-5 ${newsSlim ? "md:grid-cols-2" : "lg:grid-cols-3"}`}>
        <div data-testid="home-news-slot" className={`min-w-0 ${newsSlim ? "" : "lg:col-span-2"}`}>
          <GovConNews laneId={laneId} card={newsCard} tz={brief.viewerTz} now={now} />
        </div>
        <div data-testid="home-projects-slot" className="min-w-0">
          <ProjectsGlance laneId={laneId} canConnect={isAdmin} />
        </div>
      </div>
    </>
  );
}

/** Row 2 in its own boundary: a slow QuickBooks read (core.home_finance) never holds the rest of Home back (T-230 A). */
async function KpiSection({ laneId, feeds, canConnect }: { laneId: string; feeds: HomeView["feeds"]; canConnect: boolean }) {
  const finance = await timed("load.home_finance", async () => homeFinanceFor(await guards(), laneId));
  return <KpiStrip laneId={laneId} tiles={kpiTiles(finance, feeds)} canConnect={canConnect && finance.state !== "no_access"} />; // the banner talks about finance: not for a role without that view
}
