// Home (D-20 batch 1, p3 and p6). T-200 fills "Needs your attention" and "Today's meetings" from the lane's synced data;
// T-201 brings the prototype's layout: a gold-ruled briefing composed from that data (no AI until T-162), the four KPI
// tiles (no figures until the finance tasks and D-8: each says why), and "Coming up" when today is clear. No approvals
// yet (T-115). Mail appears as counts only: no subject, sender or body on Home.
import Link from "next/link";
import { Suspense } from "react";
import { Alert, AlertDescription, AlertTitle, Badge, buttonVariants, EmptyState, homeHeading, KpiCard, laneHref, PageHeader, PageSection } from "@nichols/ui";
import { eyebrowDate } from "@/lib/format-date";
import { guards } from "@/lib/guards";
import { cookies } from "next/headers";
import { composeBriefing, homeFor, homeKpis, type AttentionItem } from "@/lib/home";
import { briefingFor, viewerZone } from "@/lib/briefing";
import { CalendarSections, CoverageStrip } from "./home-briefing";
import { TimezoneCookie } from "./timezone-cookie";
import { loadLane } from "@/lib/lane-page";
import { OnboardingBanner } from "./onboarding-entry";
import { HomeSkeleton } from "./page-skeleton";
import { onboardingFor } from "@/lib/onboarding-progress";
import { timed } from "@/lib/timed";

export async function HomePage({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const now = new Date();
  const heading = homeHeading(); // no first name in the session yet: "Good morning"
  // T-230 A: the header renders as soon as the lane is verified; the data sections and the setup banner stream in behind it
  // (each in its own boundary, so the slow setup lookup never holds back today's figures, and neither holds the header).
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        className="mb-2"
        eyebrow={`${eyebrowDate(now)} · ${lane.name}`}
        title={heading.lead}
        accent={heading.accent}
        actions={
          <Link href={laneHref(lane.laneId, "assistant")} className={buttonVariants()}>
            Ask Jarvis
          </Link>
        }
      />
      {/* The setup banner is phone-only (md:hidden). Its slot has the banner's own height while it loads, so it never pushes the cards down. */}
      <Suspense fallback={<div aria-hidden data-testid="setup-banner-slot" className={`${BANNER_SLOT} md:hidden`} />}>
        <SetupBanner laneId={lane.laneId} />
      </Suspense>
      <Suspense fallback={<HomeSkeleton />}>
        <HomeSections laneId={lane.laneId} now={now} />
      </Suspense>
    </div>
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
  const [view, brief] = await Promise.all([
    timed("load.home", async () => homeFor(g, laneId, now)),
    timed("load.briefing", async () => briefingFor((await g.requireLane(laneId as Parameters<typeof g.requireLane>[0])).client, laneId, now, tz)),
  ]);
  return (
    <>
      <TimezoneCookie current={tzCookie ?? null} />
      {view.unavailable ? (
        <Alert variant="alert">
          <AlertTitle>Some of today&apos;s information could not be loaded</AlertTitle>
          <AlertDescription>Reload the page in a minute. If it keeps happening, check Settings → Connections.</AlertDescription>
        </Alert>
      ) : null}
      <Briefing lines={view.unavailable ? [] : composeBriefing(view, now)} />
      <CoverageStrip laneId={laneId} view={brief} now={now} />
      <section aria-label="Key figures" data-testid="home-kpis" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {homeKpis(view.feeds).map((k) => (
          <KpiCard key={k.key} label={k.label} bookBalance={k.bookBalance} status="no_data" statusText={k.statusText} />
        ))}
      </section>
      <div data-testid="home-main-grid" className="grid gap-4 lg:grid-cols-3">
        <PageSection title="Needs your attention" className="lg:col-span-2">{view.unavailable ? undefined : <AttentionList laneId={laneId} items={view.attention} />}</PageSection>
        <div className="flex min-w-0 flex-col gap-4">
          <CalendarSections view={brief} now={now} />
        </div>
      </div>
      <ProjectsNotice />
    </>
  );
}

/** "Projects at a glance" is one line while no project board is connected (the board arrives with the Projects task). */
function ProjectsNotice() {
  return (
    <section aria-label="Projects at a glance" data-testid="projects-notice" className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-card border border-border bg-card px-5 py-3 text-card-foreground shadow-card">
      <h2 className="font-heading text-card-title font-semibold text-foreground">Projects at a glance</h2>
      <p className="text-small text-muted-foreground">No project board connected. Status appears here, read-only, once the board is connected.</p>
    </section>
  );
}

function Briefing({ lines }: { lines: string[] }) {
  return (
    <section aria-label="Today's briefing" className="relative overflow-hidden rounded-card border border-border bg-card p-5 text-card-foreground shadow-card sm:p-6">
      <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-gold" />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-card-title font-semibold text-foreground">Today&apos;s briefing</h2>
        <p className="text-small text-muted-foreground">From your connected sources</p>
      </div>
      {lines.length > 0 ? (
        <p data-testid="briefing" className="mt-3 max-w-4xl text-body leading-relaxed text-foreground">
          {lines.join(" ")}
        </p>
      ) : (
        <p className="mt-3 text-body text-muted-foreground">Your briefing appears here once this company&apos;s sources are connected.</p>
      )}
    </section>
  );
}

function AttentionList({ laneId, items }: { laneId: string; items: AttentionItem[] }) {
  if (items.length === 0) {
    return <EmptyState title="Nothing needs you right now" description="Feed problems, the next meeting and unread important mail appear here." className="border-0 bg-transparent px-0 py-6" />;
  }
  return (
    <ul data-testid="attention-list" className="flex flex-col divide-y divide-border">
      {items.map((item) => (
        <li key={item.key}>
          <Link href={laneHref(laneId, item.segment)} className="flex items-center justify-between gap-3 py-3 text-body hover:underline">
            <span className="min-w-0 truncate font-medium text-foreground">{item.label}</span>
            {item.count !== undefined ? (
              <Badge variant="alert" aria-label={`${item.count} ${item.source}`}>
                {item.count}
              </Badge>
            ) : (
              <span className="shrink-0 text-muted-foreground">{item.source}</span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
