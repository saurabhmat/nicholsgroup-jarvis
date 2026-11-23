// Calendar (T-274): the signed-in person's OWN Google and Microsoft events in this lane, read-only, in Day, Week and Month views. Server-rendered; every
// control is a link (`?view=…&date=…`), the event details are native <details> (keyboard reachable, no script). Times are Eastern Time (the business zone).
// Event text (title, place, organizer) is untrusted (rule 9): React renders it as text, and a link is drawn only for an https URL (see lib/calendar-page.ts).
// States: no calendar connected (link to Settings), no access, "could not load" (never an empty calendar on an error), an account that needs reconnecting (named, linked).
import Link from "next/link";
import { headers } from "next/headers";
import { Suspense, type CSSProperties } from "react";
import { Alert, AlertDescription, AlertTitle, cn, EmptyState, laneHref, PageHeader } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { loadLane } from "@/lib/lane-page";
import { calendarFor, type CalendarAccount, type CalendarData, type CalendarEvent } from "@/lib/calendar-page";
import {
  CALENDAR_VIEWS,
  defaultViewFor,
  eventsOnDay,
  hourRange,
  layoutOverlaps,
  parseCalendarQuery,
  periodFor,
  stepTarget,
  weekday,
  ymdOf,
  type CalendarView,
  type Period,
  type Placed,
  type Ymd,
} from "@/lib/calendar-time";
import { eventWhen, formatClock, formatHour, formatYmdShort, periodTitle } from "@/lib/calendar-format";
import { CardSkeleton } from "./page-skeleton";

/** One colour per account, from theme tokens that have a light and a dark value. Classes are written out so Tailwind sees them. */
const PALETTE = [
  { dot: "bg-chart-1", chip: "border-l-chart-1 bg-chart-1/15" },
  { dot: "bg-chart-2", chip: "border-l-chart-2 bg-chart-2/15" },
  { dot: "bg-chart-3", chip: "border-l-chart-3 bg-chart-3/15" },
  { dot: "bg-chart-4", chip: "border-l-chart-4 bg-chart-4/15" },
  { dot: "bg-gold", chip: "border-l-gold bg-gold/15" },
  { dot: "bg-success", chip: "border-l-success bg-success/15" },
] as const;
const paint = (i: number) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length] ?? PALETTE[0];

const VIEW_LABEL: Record<CalendarView, string> = { day: "Day", week: "Week", month: "Month" };
const HOUR_PX = 48;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export async function CalendarPage({ params, searchParams }: { params: Promise<{ laneId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lane = await loadLane((await params).laneId);
  // The header shows as soon as the lane is verified; the calendar streams in behind it.
  return (
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow={lane.name} title="Calendar" />
      <Suspense fallback={<CardSkeleton />}>
        <CalendarBody laneId={lane.laneId} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

export async function CalendarBody({ laneId, searchParams }: { laneId: string; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ua = (await headers()).get("user-agent");
  const today = ymdOf(new Date().getTime()); // the clock is read only after the request (searchParams, headers) is known
  const query = parseCalendarQuery(sp, today, defaultViewFor(ua));
  const period = periodFor(query.view, query.date);
  const data = await calendarFor(await guards(), laneId, period);
  return <CalendarScreen laneId={laneId} today={today} period={period} data={data} />;
}

const href = (laneId: string, view: CalendarView, date: Ymd) => `${laneHref(laneId, "calendar")}?view=${view}&date=${date}`;

/** The whole page below the header, for given data (the tests render this directly). */
export function CalendarScreen({ laneId, today, period, data }: { laneId: string; today: Ymd; period: Period; data: CalendarData }) {
  return (
    <div data-testid="calendar" className="flex flex-col gap-4">
      <Toolbar laneId={laneId} today={today} period={period} />
      {data.state === "unavailable" ? (
        <Alert variant="alert">
          <AlertTitle>Could not load the calendar</AlertTitle>
          <AlertDescription>Reload the page in a minute. If it keeps happening, check Settings → Connections.</AlertDescription>
        </Alert>
      ) : data.state === "no_access" ? (
        <EmptyState title="No access to the calendar" description="Your role in this company does not include a calendar. Ask an administrator if you need it." />
      ) : data.state === "not_connected" ? (
        <EmptyState
          title="No calendar connected"
          description="Connect your Google or Microsoft account to see your events here."
          action={
            <Link href={laneHref(laneId, "settings")} className="rounded-control border border-border bg-card px-4 py-2 text-body font-medium hover:bg-muted">
              Connect in Settings
            </Link>
          }
        />
      ) : (
        <Connected laneId={laneId} today={today} period={period} data={data} />
      )}
    </div>
  );
}

function Toolbar({ laneId, today, period }: { laneId: string; today: Ymd; period: Period }) {
  const { view, date } = period;
  const btn = "rounded-control border border-border bg-card px-3 py-1.5 text-body font-medium text-foreground transition-colors hover:bg-muted";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href={href(laneId, view, today)} className={btn}>
            Today
          </Link>
          <StepControl laneId={laneId} view={view} to={stepTarget(view, date, -1, today)} label={`Previous ${view}`} glyph={"\u2039"} className={btn} />
          <StepControl laneId={laneId} view={view} to={stepTarget(view, date, 1, today)} label={`Next ${view}`} glyph={"\u203A"} className={btn} />
          <h2 data-testid="calendar-title" className="ml-1 font-heading text-card-title font-semibold text-foreground">
            {periodTitle(view, date, period.days)}
          </h2>
        </div>
        <nav aria-label="Calendar view" className="flex gap-1 rounded-control border border-border bg-card p-1">
          {CALENDAR_VIEWS.map((v) => (
            <Link
              key={v}
              href={href(laneId, v, date)}
              aria-current={v === view ? "page" : undefined}
              className={cn("rounded-control px-3 py-1 text-body font-medium transition-colors", v === view ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted")}
            >
              {VIEW_LABEL[v]}
            </Link>
          ))}
        </nav>
      </div>
      <p className="text-small text-muted-foreground">Times are Eastern Time</p>
    </div>
  );
}

/** Previous / next: a link, or a disabled control at the two-year limit (where the target is the same period). */
function StepControl({ laneId, view, to, label, glyph, className }: { laneId: string; view: CalendarView; to: Ymd | null; label: string; glyph: string; className: string }) {
  if (to === null) {
    return (
      <span role="link" aria-disabled="true" aria-label={label} className={cn(className, "cursor-not-allowed opacity-40 hover:bg-card")}>
        <span aria-hidden>{glyph}</span>
      </span>
    );
  }
  return (
    <Link href={href(laneId, view, to)} aria-label={label} className={className}>
      <span aria-hidden>{glyph}</span>
    </Link>
  );
}

type Ctx = { laneId: string; accounts: Map<string, CalendarAccount> };

function Connected({ laneId, today, period, data }: { laneId: string; today: Ymd; period: Period; data: Extract<CalendarData, { state: "connected" }> }) {
  const ctx: Ctx = { laneId, accounts: new Map(data.accounts.map((a) => [a.id, a])) };
  return (
    <>
      <Legend laneId={laneId} accounts={data.accounts} />
      {data.truncated ? (
        <p data-testid="calendar-truncated" role="status" className="rounded-control bg-alert-surface px-3 py-2 text-small text-alert-foreground">
          There are more events than are shown here. Switch to a shorter period (Week or Day) to see them all.
        </p>
      ) : null}
      {data.events.length === 0 ? <p className="text-small text-muted-foreground">No events in this period.</p> : null}
      {period.view === "month" ? <MonthView ctx={ctx} today={today} period={period} events={data.events} /> : <TimeView ctx={ctx} today={today} period={period} events={data.events} />}
    </>
  );
}

function Legend({ laneId, accounts }: { laneId: string; accounts: CalendarAccount[] }) {
  if (accounts.length === 0) return null;
  return (
    <ul aria-label="Accounts" data-testid="calendar-legend" className="flex flex-wrap gap-x-5 gap-y-1 text-small text-foreground">
      {accounts.map((a) => (
        <li key={a.id} className="flex items-center gap-2">
          <span aria-hidden className={cn("size-3 shrink-0 rounded-full", paint(a.colour).dot)} />
          <span>{a.label}</span>
          {a.problem ? (
            <Link href={laneHref(laneId, "settings")} className="font-medium text-alert-foreground underline underline-offset-2">
              {a.problem === "reconnect" ? "Needs reconnecting" : "Has connection problems"}: open Settings
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------------------- one event

function accountOf(ctx: Ctx, e: CalendarEvent): CalendarAccount | null {
  return ctx.accounts.get(e.connectionId) ?? null;
}

/** The details of an event, as text and https links only (shown inside the event's <details>). */
function EventPanel({ ctx, e, className }: { ctx: Ctx; e: CalendarEvent; className?: string }) {
  // The winning copy's account first, then the other accounts the meeting is on.
  const ids = [e.connectionId, ...e.connectionIds.filter((id) => id !== e.connectionId)];
  const accounts = ids.flatMap((id) => {
    const a = ctx.accounts.get(id);
    return a ? [a.label] : [];
  });
  return (
    <div data-testid="event-panel" className={cn("flex flex-col gap-1.5 rounded-card border border-border bg-popover p-3 text-small text-popover-foreground shadow-md", className)}>
      <p className="text-body font-semibold">{e.title}</p>
      <p>{eventWhen(e)}</p>
      {e.tentative ? <p className="text-muted-foreground">Tentative</p> : null}
      {e.location ? <p>{`Place: ${e.location}`}</p> : null}
      {e.organizer ? <p>{`Organizer: ${e.organizer}`}</p> : null}
      {accounts.length > 0 ? <p>{`${accounts.length > 1 ? "Accounts" : "Account"}: ${accounts.join(", ")}`}</p> : null}
      {e.calendarUrl || e.meetingUrl ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          {e.calendarUrl ? (
            <a href={e.calendarUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-italic underline underline-offset-2">
              {e.openLabel}
            </a>
          ) : null}
          {e.meetingUrl ? (
            <a href={e.meetingUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-italic underline underline-offset-2">
              Join
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

const chipClass = (ctx: Ctx, e: CalendarEvent) =>
  cn("border-l-4 text-foreground", paint(accountOf(ctx, e)?.colour ?? 0).chip, e.tentative && "border-dashed opacity-70");

/**
 * An event as a <details>: the summary is the chip (focusable, Enter or Space opens it), the panel follows. `floating` puts the panel over the grid
 * (an absolute box under the chip; `right` anchors it to the chip's right edge near the page edge); otherwise it opens in the flow.
 */
function EventDetails({
  ctx,
  e,
  summary,
  floating = false,
  right = false,
  up = false,
  className,
  style,
  summaryClassName,
}: {
  ctx: Ctx;
  e: CalendarEvent;
  summary: React.ReactNode;
  floating?: boolean;
  right?: boolean;
  /** Open the panel above the chip (events low in the grid or in the last month rows, so it is not cut off by the page's end). */
  up?: boolean;
  className?: string;
  style?: CSSProperties;
  summaryClassName?: string;
}) {
  return (
    <details data-testid="event" name="calendar-event" className={cn(floating && "open:z-30", className)} style={style}>
      <summary className={cn("block cursor-pointer list-none rounded-control text-small focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden", chipClass(ctx, e), summaryClassName)}>
        {summary}
        {e.tentative ? <span className="sr-only"> (tentative)</span> : null}
      </summary>
      <EventPanel ctx={ctx} e={e} className={floating ? cn("absolute z-30 w-72 max-w-[80vw]", up ? "bottom-full mb-1" : "top-full mt-1", right ? "right-0" : "left-0") : "mt-1"} />
    </details>
  );
}

const timeLabel = (e: CalendarEvent) => (e.allDay ? "" : `${formatClock(e.startAt)} `);

// ---------------------------------------------------------------------------------------------------------- Day and Week

function dayHeading(laneId: string, day: Ymd, today: Ymd) {
  const isToday = day === today;
  return (
    <Link
      href={href(laneId, "day", day)}
      aria-current={isToday ? "date" : undefined}
      className={cn("flex flex-col items-center rounded-control px-1 py-1 text-small hover:bg-muted", isToday && "bg-primary text-primary-foreground hover:bg-primary-hover")}
    >
      <span className="text-label">{WEEKDAYS[weekday(day)]}</span>
      <span className="text-body font-semibold">{String(Number(day.slice(8)))}</span>
    </Link>
  );
}

function TimeView({ ctx, today, period, events }: { ctx: Ctx; today: Ymd; period: Period; events: CalendarEvent[] }) {
  const perDay = period.days.map((day) => {
    const x = eventsOnDay(events, day);
    return { day, allDay: x.allDay, placed: layoutOverlaps(x.timed) };
  });
  const { startHour, endHour } = hourRange(perDay.flatMap((d) => d.placed));
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const startMin = startHour * 60;
  const span = (endHour - startHour) * 60;
  const cols = `3.25rem repeat(${String(period.days.length)}, minmax(0, 1fr))`;
  const isWeek = period.view === "week";
  return (
    <>
      <div data-testid="calendar-grid" className={cn("rounded-card border border-border bg-card", isWeek && "hidden md:block")}>
        <div className="grid rounded-t-card border-b border-border" style={{ gridTemplateColumns: cols }}>
          <div />
          {perDay.map((d) => (
            <div key={d.day} className="border-l border-divider p-1">
              {dayHeading(ctx.laneId, d.day, today)}
            </div>
          ))}
        </div>
        <div data-testid="calendar-allday" className="grid border-b border-border" style={{ gridTemplateColumns: cols }}>
          <div className="p-1 text-label text-muted-foreground">All day</div>
          {perDay.map((d, i) => (
            <div key={d.day} className="flex min-h-8 flex-col gap-1 border-l border-divider p-1">
              {d.allDay.map((e) => (
                <EventDetails key={e.key} ctx={ctx} e={e} floating right={period.days.length > 1 && i >= period.days.length - 3} summary={<span className="block truncate px-1.5 py-0.5">{e.title}</span>} className="relative" />
              ))}
            </div>
          ))}
        </div>
        <div className="grid rounded-b-card" style={{ gridTemplateColumns: cols }}>
          <div className="relative" style={{ height: hours.length * HOUR_PX }}>
            {hours.map((h, i) => (
              <span key={h} className="absolute right-1 -translate-y-1/2 text-label text-muted-foreground" style={{ top: i * HOUR_PX, display: i === 0 ? "none" : undefined }}>
                {formatHour(h)}
              </span>
            ))}
          </div>
          {perDay.map((d, ci) => (
            <div key={d.day} data-testid="calendar-day" data-day={d.day} className={cn("relative border-l border-divider", d.day === today && "bg-primary-tint/40")} style={{ height: hours.length * HOUR_PX }}>
              {hours.map((h, i) => (
                <div key={h} aria-hidden className="absolute inset-x-0 border-t border-divider" style={{ top: i * HOUR_PX }} />
              ))}
              {d.placed.map((p) => (
                <EventDetails
                  key={p.event.key}
                  ctx={ctx}
                  e={p.event}
                  floating
                  up={p.top - startMin > span / 2}
                  right={period.days.length > 1 ? ci >= period.days.length - 3 : p.column > 0}
                  className="absolute px-px"
                  style={placeStyle(p, startMin, span)}
                  summaryClassName="h-full overflow-hidden px-1.5 py-0.5"
                  summary={
                    <>
                      <span className="block truncate font-medium">{p.event.title}</span>
                      {p.bottom - p.top >= 40 ? <span className="block truncate text-muted-foreground">{formatClock(p.event.startAt)}</span> : null}
                    </>
                  }
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {isWeek ? <WeekList ctx={ctx} today={today} perDay={perDay.map((d) => ({ day: d.day, all: [...d.allDay, ...d.placed.map((p) => p.event)] }))} /> : null}
    </>
  );
}

function placeStyle(p: Placed<CalendarEvent>, startMin: number, span: number): CSSProperties {
  const top = Math.max(0, p.top - startMin);
  const bottom = Math.min(span, p.bottom - startMin);
  return {
    top: `${((top / span) * 100).toFixed(3)}%`,
    height: `${(((bottom - top) / span) * 100).toFixed(3)}%`,
    left: `${((p.column / p.columns) * 100).toFixed(3)}%`,
    width: `${(100 / p.columns).toFixed(3)}%`,
  };
}

/** Phone Week: the days as a list, each with its events. */
function WeekList({ ctx, today, perDay }: { ctx: Ctx; today: Ymd; perDay: { day: Ymd; all: CalendarEvent[] }[] }) {
  return (
    <ol data-testid="calendar-week-list" className="flex flex-col gap-3 md:hidden">
      {perDay.map((d) => (
        <li key={d.day} className="rounded-card border border-border bg-card p-3">
          <h3 className="mb-2 text-body font-semibold">
            <Link href={href(ctx.laneId, "day", d.day)} aria-current={d.day === today ? "date" : undefined} className={cn("hover:underline", d.day === today && "text-accent-italic")}>
              {formatYmdShort(d.day)}
              {d.day === today ? " (today)" : ""}
            </Link>
          </h3>
          {d.all.length === 0 ? (
            <p className="text-small text-muted-foreground">No events</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {d.all.map((e) => (
                <li key={e.key}>
                  <EventDetails ctx={ctx} e={e} summary={<span className="block px-2 py-1.5">{`${e.allDay ? "All day " : timeLabel(e)}${e.title}`}</span>} />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------------------- Month

const MONTH_MAX = 3;

function MonthView({ ctx, today, period, events }: { ctx: Ctx; today: Ymd; period: Period; events: CalendarEvent[] }) {
  const month = period.date.slice(0, 7);
  return (
    <div data-testid="calendar-month" className="rounded-card border border-border bg-card">
      <div className="grid grid-cols-7 rounded-t-card border-b border-border text-center text-label text-muted-foreground">
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-1.5">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {period.days.map((day, i) => {
          const x = eventsOnDay(events, day);
          const all = [...x.allDay, ...x.timed.map((s) => s.event)];
          const shown = all.slice(0, MONTH_MAX);
          const more = all.length - shown.length;
          const isToday = day === today;
          const col = i % 7;
          const last = period.days.length - 1;
          const lastRows = i >= period.days.length - 14;
          return (
            <div key={day} data-testid="calendar-cell" data-day={day} className={cn("relative min-h-14 border-b border-l border-divider p-1 md:min-h-28", day.slice(0, 7) !== month && "bg-muted/50 text-muted-foreground", i === last - 6 && "rounded-bl-card", i === last && "rounded-br-card")}>
              <Link
                href={href(ctx.laneId, "day", day)}
                aria-current={isToday ? "date" : undefined}
                className={cn("inline-flex size-7 items-center justify-center rounded-full text-small font-medium hover:bg-muted", isToday && "bg-primary text-primary-foreground hover:bg-primary-hover")}
              >
                {String(Number(day.slice(8)))}
              </Link>
              {/* Phone: coloured dots (the Day view has the names). From md: the first three events by name. */}
              <div className="mt-1 flex flex-wrap gap-1 md:hidden">
                {all.slice(0, 6).map((e) => (
                  <span key={e.key} aria-hidden className={cn("size-2 rounded-full", paint(accountOf(ctx, e)?.colour ?? 0).dot, e.tentative && "opacity-50")} />
                ))}
                {all.length > 0 ? <span className="sr-only">{`${String(all.length)} events`}</span> : null}
              </div>
              <div className="mt-1 hidden flex-col gap-0.5 md:flex">
                {shown.map((e) => (
                  <EventDetails key={e.key} ctx={ctx} e={e} floating up={lastRows} right={col >= 4} className="relative" summary={<span className="block truncate px-1.5 py-0.5">{`${timeLabel(e)}${e.title}`}</span>} />
                ))}
                {more > 0 ? (
                  <Link href={href(ctx.laneId, "day", day)} className="px-1.5 text-small font-medium text-accent-italic hover:underline">
                    {`+${String(more)} more`}
                  </Link>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

