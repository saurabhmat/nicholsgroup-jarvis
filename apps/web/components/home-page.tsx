// Home (D-20 batch 1, p3 and p6). T-200 fills "Needs your attention" and "Today's meetings" from the lane's synced data;
// the briefing (T-162) and project status keep their empty states until their tasks land. No figures (finance needs
// D-8) and no approvals yet (T-115). Mail appears as counts only: no subject, sender or body on Home.
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle, Badge, buttonVariants, EmptyState, homeHeading, laneHref, PageHeader, PageSection } from "@nichols/ui";
import { eyebrowDate } from "@/lib/format-date";
import { guards } from "@/lib/guards";
import { formatTime, homeFor, type AttentionItem, type CalendarState, type HomeMeeting } from "@/lib/home";
import { loadLane } from "@/lib/lane-page";

export async function HomePage({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const now = new Date();
  const view = await homeFor(await guards(), lane.laneId, now);
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
      {view.unavailable ? (
        <Alert variant="alert">
          <AlertTitle>Some of today&apos;s information could not be loaded</AlertTitle>
          <AlertDescription>Reload the page in a minute. If it keeps happening, check Settings → Connections.</AlertDescription>
        </Alert>
      ) : null}
      <PageSection title="Today's briefing" emptyTitle="No briefing yet" emptyDescription="Your daily briefing appears here once it is switched on for this company." />
      <div className="grid gap-6 lg:grid-cols-2">
        <PageSection title="Needs your attention">{view.unavailable ? undefined : <AttentionList laneId={lane.laneId} items={view.attention} />}</PageSection>
        <PageSection title="Today's meetings" note={view.meetings.length > 0 ? "Google Calendar" : undefined}>
          {view.unavailable ? undefined : <Meetings calendar={view.calendar} meetings={view.meetings} now={now} />}
        </PageSection>
      </div>
      <PageSection title="Projects at a glance" emptyTitle="No project board connected" emptyDescription="Project status appears here, read-only, once the project board is connected." />
    </div>
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

function Meetings({ calendar, meetings, now }: { calendar: CalendarState; meetings: HomeMeeting[]; now: Date }) {
  if (calendar === "no_access") {
    return <EmptyState title="No calendar to show" description="Your role in this company does not include the calendar." className="border-0 bg-transparent px-0 py-6" />;
  }
  if (calendar === "not_connected") {
    return <EmptyState title="No calendar connected" description="Today's meetings appear here once Google is connected in Settings." className="border-0 bg-transparent px-0 py-6" />;
  }
  if (meetings.length === 0) {
    return <EmptyState title="Nothing scheduled today" description="Your calendar has no meetings for the rest of today." className="border-0 bg-transparent px-0 py-6" />;
  }
  return (
    <ul data-testid="meeting-list" className="flex flex-col divide-y divide-border">
      {meetings.map((m, i) => {
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
  );
}
