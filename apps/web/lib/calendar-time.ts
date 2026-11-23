// T-274: the Calendar page's date arithmetic and layout, pure (no clock, no I/O). Everything is in America/New_York (the business zone, rule 11).
// A "civil date" is a "YYYY-MM-DD" string. A New York day is [dayStart(d), dayStart(d + 1)): 23 hours on the spring-forward day, 25 on the fall-back day.
// Grid positions use WALL-CLOCK minutes (0 to 1440), so every day column of a week has the same 24 rows; an hour that does not exist (Mar 8 2 AM)
// is an empty row and the repeated hour (Nov 1 1 AM) shows its events on the one row.
export const BUSINESS_TZ = "America/New_York";
export type Ymd = string;
export type CalendarView = "day" | "week" | "month";
export const CALENDAR_VIEWS: readonly CalendarView[] = ["day", "week", "month"];
const DAY_MS = 86_400_000;

type Parts = { y: number; m: number; d: number; hh: number; mm: number; ss: number };

const FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function nyParts(ms: number): Parts {
  const parts = FMT.formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: n("year"), m: n("month"), d: n("day"), hh: n("hour"), mm: n("minute"), ss: n("second") };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const toYmd = (y: number, m: number, d: number): Ymd => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

/** A real calendar date in strict YYYY-MM-DD form (2026-02-30 is not one). */
export function isYmd(v: unknown): v is Ymd {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  return toYmd(y, m, d) === v;
}

const parse = (v: Ymd): [number, number, number] => v.split("-").map(Number) as [number, number, number];
export const addDays = (v: Ymd, n: number): Ymd => {
  const [y, m, d] = parse(v);
  return toYmd(y, m, d + n);
};
/** Months move to the first of the month (a month view has no day of its own). */
export const addMonths = (v: Ymd, n: number): Ymd => {
  const [y, m] = parse(v);
  return toYmd(y, m + n, 1);
};
/** 0 = Sunday. */
export const weekday = (v: Ymd): number => {
  const [y, m, d] = parse(v);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
export const daysBetween = (a: Ymd, b: Ymd): number => {
  const [ay, am, ad] = parse(a);
  const [by, bm, bd] = parse(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
};

/** The New York civil date of an instant. */
export function ymdOf(ms: number): Ymd {
  const p = nyParts(ms);
  return toYmd(p.y, p.m, p.d);
}

/** The instant of 00:00 New York time on a civil date (DST-safe: the offset is taken at midnight itself). */
export function dayStart(v: Ymd): number {
  const [y, m, d] = parse(v);
  const guess = Date.UTC(y, m - 1, d);
  const off = (at: number) => {
    const p = nyParts(at);
    return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(at / 1000) * 1000;
  };
  const first = guess - off(guess);
  return guess - off(first);
}

/** Hours in the New York day: 23, 24 or 25. */
export const hoursInDay = (v: Ymd): number => Math.round((dayStart(addDays(v, 1)) - dayStart(v)) / 3_600_000);

/** Minutes after wall-clock midnight (0 to 1439) of an instant. */
export function wallMinutes(ms: number): number {
  const p = nyParts(ms);
  return p.hh * 60 + p.mm;
}

// ---------------------------------------------------------------------------------------------------------- the URL

export const DEFAULT_VIEW: CalendarView = "week";
const MAX_DISTANCE_DAYS = 731;

export type CalendarQuery = { view: CalendarView; date: Ymd; /** The URL named a view (otherwise the default for the device applies). */ explicitView: boolean };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/** `?view=day|week|month&date=YYYY-MM-DD`. Anything else falls back to the default view and today; a date more than two years from today is clamped to that limit. */
export function parseCalendarQuery(params: Record<string, string | string[] | undefined>, today: Ymd, defaultView: CalendarView = DEFAULT_VIEW): CalendarQuery {
  const v = one(params.view);
  const explicitView = v !== undefined && (CALENDAR_VIEWS as readonly string[]).includes(v);
  const view = explicitView ? (v as CalendarView) : defaultView;
  const d = one(params.date);
  const date = clampDate(isYmd(d) ? d : today, today);
  return { view, date, explicitView };
}

/** The phone default is Day; everything else Week. From the first 512 characters of the User-Agent only, with simple tests (a hint for the default, never a permission). */
export function defaultViewFor(userAgent: string | null | undefined): CalendarView {
  if (typeof userAgent !== "string") return DEFAULT_VIEW;
  const ua = userAgent.slice(0, 512);
  const phone = /iPhone|iPod|Windows Phone/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua));
  return phone ? "day" : DEFAULT_VIEW;
}

/** A date clamped to two years either side of today (the same rule the URL parser applies). */
export function clampDate(date: Ymd, today: Ymd): Ymd {
  const away = daysBetween(today, date);
  return away > MAX_DISTANCE_DAYS ? addDays(today, MAX_DISTANCE_DAYS) : away < -MAX_DISTANCE_DAYS ? addDays(today, -MAX_DISTANCE_DAYS) : date;
}

// ---------------------------------------------------------------------------------------------------------- windows

export type Period = {
  view: CalendarView;
  /** The date the view is anchored on. */
  date: Ymd;
  /** Every civil date the view shows, in order (1, 7, or 28 to 42 days). */
  days: Ymd[];
  /** The query window: from the first day's start to the day after the last. At most 43 days. */
  from: Date;
  to: Date;
};

const firstOfMonth = (v: Ymd): Ymd => `${v.slice(0, 8)}01`;
const weekStart = (v: Ymd): Ymd => addDays(v, -weekday(v));

export function periodFor(view: CalendarView, date: Ymd): Period {
  let days: Ymd[];
  if (view === "day") days = [date];
  else if (view === "week") {
    const s = weekStart(date);
    days = Array.from({ length: 7 }, (_, i) => addDays(s, i));
  } else {
    const first = firstOfMonth(date);
    const last = addDays(addMonths(first, 1), -1);
    const s = weekStart(first);
    const e = addDays(weekStart(last), 6);
    days = Array.from({ length: daysBetween(s, e) + 1 }, (_, i) => addDays(s, i));
  }
  const first = days[0] as Ymd;
  const last = days[days.length - 1] as Ymd;
  return { view, date, days, from: new Date(dayStart(first)), to: new Date(dayStart(addDays(last, 1))) };
}

/** The date the previous and next links go to. */
export function step(view: CalendarView, date: Ymd, dir: -1 | 1): Ymd {
  return view === "day" ? addDays(date, dir) : view === "week" ? addDays(date, 7 * dir) : addMonths(date, dir);
}

// ---------------------------------------------------------------------------------------------------------- events on days

/** What the layout needs of an event; the page's event type has more. */
export type Span = {
  allDay: boolean;
  /** ISO instants (timed events). */
  startAt: string;
  endAt: string;
  /** Civil dates (all-day events; the end is exclusive). */
  startDate: Ymd | null;
  endDate: Ymd | null;
};

/** Whether an event shows on a New York civil day. A timed event crossing midnight shows on each day it touches; an all-day event on [startDate, endDate). */
export function onDay(e: Span, day: Ymd): boolean {
  if (e.allDay) return e.startDate !== null && e.endDate !== null && e.startDate <= day && day < e.endDate;
  const s = Date.parse(e.startAt);
  const t = Date.parse(e.endAt);
  const a = dayStart(day);
  const b = dayStart(addDays(day, 1));
  return (s < b && t > a) || (s === t && s >= a && s < b);
}

export type Segment<T> = { event: T; /** Wall-clock minutes from midnight. */ top: number; bottom: number };

export const MIN_SEGMENT_MINUTES = 20;

/** The part of a timed event on one day, in wall-clock minutes; a part that runs to the end of the day ends at 1440. At least MIN_SEGMENT_MINUTES tall, never past the day. */
export function segmentOn<T extends Span>(e: T, day: Ymd): Segment<T> {
  const s = Date.parse(e.startAt);
  const t = Date.parse(e.endAt);
  const a = dayStart(day);
  const b = dayStart(addDays(day, 1));
  const top = s <= a ? 0 : wallMinutes(s);
  let bottom = t >= b ? 1440 : wallMinutes(t);
  // The repeated hour of the fall-back day can make a later instant read earlier on the wall clock.
  if (bottom < top) bottom = top;
  bottom = Math.max(bottom, top + MIN_SEGMENT_MINUTES);
  if (bottom > 1440) return { event: e, top: Math.max(0, 1440 - MIN_SEGMENT_MINUTES), bottom: 1440 };
  return { event: e, top, bottom };
}

export type DayEvents<T> = { day: Ymd; allDay: T[]; timed: Segment<T>[] };

export function eventsOnDay<T extends Span & { title: string }>(events: readonly T[], day: Ymd): DayEvents<T> {
  const mine = events.filter((e) => onDay(e, day));
  return {
    day,
    allDay: mine.filter((e) => e.allDay).sort((x, y) => x.title.localeCompare(y.title)),
    timed: mine
      .filter((e) => !e.allDay)
      .map((e) => segmentOn(e, day))
      .sort((x, y) => x.top - y.top || y.bottom - x.bottom || x.event.title.localeCompare(y.event.title)),
  };
}

export type Placed<T> = Segment<T> & { /** 0-based column inside its group of overlapping events. */ column: number; /** Columns in the group. */ columns: number };

/** Side-by-side layout: events that overlap (directly or through a chain) share a group; each takes the first free column inside it. */
export function layoutOverlaps<T>(segments: readonly Segment<T>[]): Placed<T>[] {
  const sorted = [...segments].sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const out: Placed<T>[] = [];
  let group: Placed<T>[] = [];
  let groupEnd = -1;
  let colEnds: number[] = [];
  const flush = () => {
    for (const p of group) p.columns = colEnds.length;
    out.push(...group);
    group = [];
    colEnds = [];
    groupEnd = -1;
  };
  for (const s of sorted) {
    if (group.length > 0 && s.top >= groupEnd) flush();
    let column = colEnds.findIndex((end) => end <= s.top);
    if (column === -1) {
      column = colEnds.length;
      colEnds.push(s.bottom);
    } else colEnds[column] = s.bottom;
    group.push({ ...s, column, columns: 1 });
    groupEnd = Math.max(groupEnd, s.bottom);
  }
  flush();
  return out;
}

/** The hours an hour grid shows (whole hours, wall clock): 8 AM to 8 PM, widened to include every event on the page. */
export function hourRange(segments: readonly { top: number; bottom: number }[]): { startHour: number; endHour: number } {
  let startHour = 8;
  let endHour = 20;
  for (const s of segments) {
    startHour = Math.min(startHour, Math.floor(s.top / 60));
    endHour = Math.max(endHour, Math.ceil(s.bottom / 60));
  }
  return { startHour: Math.max(0, startHour), endHour: Math.min(24, endHour) };
}

/** Where Previous or Next goes, or null when that would land back in the same period (the two-year limit). */
export function stepTarget(view: CalendarView, date: Ymd, dir: -1 | 1, today: Ymd): Ymd | null {
  const target = clampDate(step(view, date, dir), today);
  return periodFor(view, target).days[0] === periodFor(view, date).days[0] ? null : target;
}
