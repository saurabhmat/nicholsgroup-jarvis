// Home (D-20 batch 1, p3 and p6). T-200 fills "Needs your attention" and "Today's meetings" from the lane's synced data;
// T-201 brings the prototype's layout: a gold-ruled briefing composed from that data (no AI until T-162), the four KPI
// tiles (no figures until the finance tasks and D-8: each says why), and "Coming up" when today is clear. No approvals
// yet (T-115). Mail appears as counts only: no subject, sender or body on Home.
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle, Badge, buttonVariants, EmptyState, homeHeading, KpiCard, laneHref, PageHeader, PageSection } from "@nichols/ui";
import { eyebrowDate } from "@/lib/format-date";
import { guards } from "@/lib/guards";
import { composeBriefing, formatDay, formatTime, homeFor, homeKpis, timedLeft, type AttentionItem, type CalendarState, type HomeMeeting } from "@/lib/home";
import { loadLane } from "@/lib/lane-page";
import { OnboardingBanner } from "./onboarding-entry";
import { onboardingFor } from "@/lib/onboarding-progress";

export async function HomePage({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const now = new Date();
  const view = await homeFor(await guards(), lane.laneId, now);
  const onboarding = await onboardingFor(lane.laneId);
  const heading = homeHeading(); // no first name in the session yet: "Good morning"
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`${eyebrowDate(now)} · ${lane.name}`}
        title={heading.lead}
        accent={heading.accent}
        actions={
          <Link href={laneHref(lane.laneId, "assistant")} className={buttonVariants()}>
            Ask Jarvis
          </Link>
        }
      />
      <OnboardingBanner laneId={lane.laneId} progress={onboarding} />
      {view.unavailable ? (
        <Alert variant="alert">
          <AlertTitle>Some of today&apos;s information could not be loaded</AlertTitle>
          <AlertDescription>Reload the page in a minute. If it keeps happening, check Settings → Connections.</AlertDescription>
        </Alert>
      ) : null}
      <Briefing lines={view.unavailable ? [] : composeBriefing(view, now)} />
      <section aria-label="Key figures" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {homeKpis(view.feeds).map((k) => (
          <KpiCard key={k.key} label={k.label} bookBalance={k.bookBalance} status="no_data" statusText={k.statusText} />
        ))}
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <PageSection title="Needs your attention">{view.unavailable ? undefined : <AttentionList laneId={lane.laneId} items={view.attention} />}</PageSection>
        <PageSection title="Today's meetings" note={view.meetings.length > 0 || view.upcoming.length > 0 ? "Google Calendar" : undefined}>
          {view.unavailable ? undefined : <Meetings calendar={view.calendar} meetings={view.meetings} upcoming={view.upcoming} now={now} />}
        </PageSection>
      </div>
      <PageSection title="Projects at a glance" emptyTitle="No project board connected" emptyDescription="Project status appears here, read-only, once the project board is connected." />
    </div>
  );
}

function Briefing({ lines }: { lines: string[] }) {
  return (
    <section aria-label="Today's briefing" className="relative overflow-hidden rounded-card border border-border bg-card p-5 text-card-foreground sm:p-6">
      <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-gold" />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl font-semibold text-foreground">Today&apos;s briefing</h2>
        <p className="text-xs text-muted-foreground">From your connected sources</p>
      </div>
      {lines.length > 0 ? (
        <p data-testid="briefing" className="mt-3 max-w-3xl text-base leading-relaxed text-foreground">
          {lines.join(" ")}
        </p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Your briefing appears here once this company&apos;s sources are connected.</p>
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
          <Link href={laneHref(laneId, item.segment)} className="flex items-center justify-between gap-3 py-3 text-sm hover:underline">
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

function Meetings({ calendar, meetings, upcoming, now }: { calendar: CalendarState; meetings: HomeMeeting[]; upcoming: HomeMeeting[]; now: Date }) {
  if (calendar === "no_access") {
    return <EmptyState title="No calendar to show" description="Your role in this company does not include the calendar." className="border-0 bg-transparent px-0 py-6" />;
  }
  if (calendar === "not_connected") {
    return <EmptyState title="No calendar connected" description="Today's meetings appear here once Google is connected in Settings." className="border-0 bg-transparent px-0 py-6" />;
  }
  // Nothing timed left today: keep any all-day events, say the day is clear, and show what is coming up.
  const anyLeft = timedLeft(meetings, now).length > 0;
  const shown = anyLeft ? meetings : meetings.filter((m) => m.allDay);
  const clear = anyLeft ? null : (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{meetings.length === 0 ? "Nothing scheduled today." : meetings.some((m) => !m.allDay) ? "No more meetings today." : "No meetings today."}</p>
      {upcoming.length > 0 ? <ComingUp meetings={upcoming} /> : null}
    </div>
  );
  if (shown.length === 0) return clear;
  return (
    <div className="flex flex-col gap-3">
      <ul data-testid="meeting-list" className="flex flex-col divide-y divide-border">
        {shown.map((m, i) => {
          const past = !m.allDay && Date.parse(m.endAt) <= now.getTime();
          return (
            <li key={`${String(i)}:${m.startAt}`} className={`flex gap-4 py-3 text-sm ${past ? "opacity-60" : ""}`}>
              <span className="w-32 shrink-0 tabular-nums text-muted-foreground">{m.allDay ? "All day" : `${formatTime(m.startAt)} – ${formatTime(m.endAt)}`}</span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="truncate font-medium text-foreground">{m.title}</span>
                {m.location ? <span className="truncate text-muted-foreground">{m.location}</span> : null}
                {m.meetingUrl || m.calendarUrl ? (
                  <span className="flex gap-3">
                    {m.meetingUrl && !past ? (
                      <a href={m.meetingUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
                        Join
                      </a>
                    ) : null}
                    {m.calendarUrl ? (
                      <a href={m.calendarUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
                        Open in Calendar
                      </a>
                    ) : null}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {clear}
    </div>
  );
}

function ComingUp({ meetings }: { meetings: HomeMeeting[] }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Coming up</h3>
      <ul data-testid="upcoming-list" className="flex flex-col divide-y divide-border">
        {meetings.map((m, i) => (
          <li key={`${String(i)}:${m.startAt}`} className="flex gap-4 py-3 text-sm">
            <span className="w-32 shrink-0 tabular-nums text-muted-foreground">
              {formatDay(m.startAt)}
              <br />
              {formatTime(m.startAt)}
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-medium text-foreground">{m.title}</span>
              {m.location ? <span className="truncate text-muted-foreground">{m.location}</span> : null}
              {m.calendarUrl ? (
                <a href={m.calendarUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
                  Open in Calendar
                </a>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
