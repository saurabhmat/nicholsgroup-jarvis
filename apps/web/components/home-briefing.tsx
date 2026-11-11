// Home briefing sections (T-231a): Coverage strip, Today's calendar and the 7-day look-ahead, from synced metadata only.
// Times are in the viewer's zone; an event's own zone is added when its clock differs. Declined and cancelled events
// never show; clashes, back-to-backs and unanswered invitations are flagged.
import Link from "next/link";
import { Badge, EmptyState, laneHref, PageSection } from "@nichols/ui";
import { attendeeSummary, formatDayIn, formatTimeIn, timeWithZone, ago, type CoverageItem, type DayEvent, type NotableEvent } from "@nichols/briefing/domain";
import type { BriefingView, CalendarSection } from "@/lib/briefing";

const STATE_BADGE: Record<CoverageItem["state"], { label: string; variant: "success" | "alert" | "muted" | "outline" }> = {
  ok: { label: "OK", variant: "success" },
  stale: { label: "Stale", variant: "outline" },
  error: { label: "Error", variant: "alert" },
  not_connected: { label: "Not connected", variant: "muted" },
};

export function CoverageStrip({ laneId, view, now }: { laneId: string; view: BriefingView; now: Date }) {
  return (
    <section aria-label="Coverage" data-testid="coverage-strip" className="flex flex-col gap-2 rounded-card border border-border bg-card px-5 py-3 text-card-foreground shadow-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-card-title font-semibold text-foreground">Coverage</h2>
        <Link href={`${laneHref(laneId, "settings")}#connections`} className="text-small text-primary underline-offset-2 hover:underline">
          Connections in Settings
        </Link>
      </div>
      <p data-testid="coverage-line" className="text-small text-muted-foreground">
        {view.coverageLine}
      </p>
      {view.coverage.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border">
          {view.coverage.map((c) => {
            const badge = STATE_BADGE[c.state];
            return (
              <li key={`${c.stream}:${c.account}`} data-testid="coverage-item" data-state={c.state} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-body">
                <span className="w-20 shrink-0 text-muted-foreground">{c.stream === "mail" ? "Mail" : "Calendar"}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{c.account}</span>
                <span className="text-small text-muted-foreground">
                  {c.lastSyncAt ? `Synced ${formatTimeIn(c.lastSyncAt, view.viewerTz)} (${ago(c.lastSyncAt, now)})` : "Never synced"}
                </span>
                <Badge variant={badge.variant}>{badge.label}</Badge>
                {c.reason ? <span className="basis-full text-small text-muted-foreground">{c.reason}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function Flags({ e }: { e: DayEvent }) {
  const flags: { text: string; variant: "alert" | "outline" | "gold" }[] = [];
  if (e.clashesWith.length > 0) flags.push({ text: `Clashes with ${e.clashesWith.join(", ")}`, variant: "alert" });
  if (e.backToBack) flags.push({ text: "Back-to-back", variant: "outline" });
  if (e.rsvpPending) flags.push({ text: "RSVP pending", variant: "gold" });
  if (e.external.length > 0) flags.push({ text: "External", variant: "outline" });
  if (flags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-2">
      {flags.map((f) => (
        <Badge key={f.text} variant={f.variant}>
          {f.text}
        </Badge>
      ))}
    </span>
  );
}

export function TodayCalendar({ calendar, tz, now }: { calendar: CalendarSection; tz: string; now: Date }) {
  if (!calendar.access) {
    return <EmptyState title="No calendar to show" description="Your role does not include the calendar, or it could not be read. See Coverage." className="border-0 bg-transparent px-0 py-6" />;
  }
  if (calendar.today.length === 0) return <p className="text-body text-muted-foreground">Nothing scheduled today.</p>;
  const owners = new Set(calendar.owners);
  return (
    <ul data-testid="today-calendar" className="flex flex-col divide-y divide-border">
      {calendar.today.map((e) => {
        const past = !e.allDay && Date.parse(e.endAt) <= now.getTime();
        const who = attendeeSummary(e, owners);
        return (
          <li key={e.key} data-testid="calendar-event" className={`flex gap-4 py-3 text-body ${past ? "opacity-60" : ""}`}>
            <span className="w-36 shrink-0 tabular-nums text-muted-foreground">
              {e.allDay ? "All day" : `${timeWithZone(e.startAt, tz, e.timezone)} – ${formatTimeIn(e.endAt, tz)}`}
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-medium text-foreground">{e.title}</span>
              {e.location ? <span className="truncate text-muted-foreground">{e.location}</span> : null}
              {who ? <span className="truncate text-small text-muted-foreground">With {who}</span> : null}
              <Flags e={e} />
              {e.meetingUrl || e.calendarUrl ? (
                <span className="flex gap-3">
                  {e.meetingUrl && !past ? (
                    <a href={e.meetingUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
                      Join
                    </a>
                  ) : null}
                  {e.calendarUrl ? (
                    <a href={e.calendarUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
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

export function LookAhead({ events, tz }: { events: NotableEvent[]; tz: string }) {
  if (events.length === 0) return <p className="text-body text-muted-foreground">Nothing notable in the next 7 days (no holidays, external meetings or open invitations).</p>;
  return (
    <ul data-testid="look-ahead" className="flex flex-col divide-y divide-border">
      {events.map((e) => (
        <li key={e.key} className="flex gap-4 py-3 text-body">
          <span className="w-36 shrink-0 tabular-nums text-muted-foreground">
            {formatDayIn(e.allDay && e.startDate ? `${e.startDate}T12:00:00Z` : e.startAt, tz)}
            {e.allDay ? null : (
              <>
                <br />
                {timeWithZone(e.startAt, tz, e.timezone)}
              </>
            )}
          </span>
          <span className="flex min-w-0 flex-col gap-1">
            {e.calendarUrl ? (
              <a href={e.calendarUrl} target="_blank" rel="noopener noreferrer" className="truncate font-medium text-foreground underline-offset-2 hover:underline">
                {e.title}
              </a>
            ) : (
              <span className="truncate font-medium text-foreground">{e.title}</span>
            )}
            <span className="text-small text-muted-foreground">{e.why.join(" · ")}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CalendarSections({ view, now }: { view: BriefingView; now: Date }) {
  return (
    <>
      <PageSection title="Today's calendar" note={`Times in ${view.viewerTz.replace(/_/g, " ")}`}>
        <TodayCalendar calendar={view.calendar} tz={view.viewerTz} now={now} />
      </PageSection>
      <PageSection title="Next 7 days">{view.calendar.access ? <LookAhead events={view.calendar.ahead} tz={view.viewerTz} /> : <p className="text-body text-muted-foreground">No calendar to look ahead in. See Coverage.</p>}</PageSection>
    </>
  );
}
