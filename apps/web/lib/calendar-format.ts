// T-274: the Calendar page's wording of dates and times, all in America/New_York. Pure.
import { BUSINESS_TZ, addDays, type Span, type Ymd } from "./calendar-time";

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: BUSINESS_TZ });
const DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: BUSINESS_TZ });
const LONG_DAY = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const HOUR = new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: BUSINESS_TZ });

const noon = (v: Ymd) => new Date(`${v}T12:00:00Z`);

export const formatClock = (iso: string) => TIME.format(new Date(iso));
/** "Mon, Nov 23" for an instant, in New York. */
export const formatInstantDay = (iso: string) => DAY.format(new Date(iso));
/** "Mon, Nov 23" for a civil date. */
export const formatYmdShort = (v: Ymd) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(noon(v));
/** "Monday, November 23, 2026". */
export const formatYmdLong = (v: Ymd) => LONG_DAY.format(noon(v));
/** "8 AM" for a wall-clock hour (0 to 24). */
export const formatHour = (h: number) => HOUR.format(new Date(`2026-01-15T${String(h % 24).padStart(2, "0")}:00:00-05:00`));

/** The title of a period: "Monday, November 23, 2026", "Nov 22 – 28, 2026" / "Nov 29 – Dec 5, 2026", "November 2026". */
export function periodTitle(view: "day" | "week" | "month", date: Ymd, days: readonly Ymd[]): string {
  if (view === "day") return formatYmdLong(date);
  if (view === "month") return MONTH.format(noon(date));
  const first = days[0] as Ymd;
  const last = days[days.length - 1] as Ymd;
  const sameMonth = first.slice(0, 7) === last.slice(0, 7);
  const lastText = sameMonth ? String(Number(last.slice(8))) : SHORT.format(noon(last));
  const year = last.slice(0, 4);
  return `${SHORT.format(noon(first))} – ${lastText}, ${year}`;
}

/** When an event happens, as text: "All day, Mon, Nov 23", "All day, Mon, Nov 23 to Wed, Nov 25", "Mon, Nov 23, 9:00 AM to 10:00 AM", or across days. */
export function eventWhen(e: Span): string {
  if (e.allDay && e.startDate && e.endDate) {
    const last = addDays(e.endDate, -1);
    return last > e.startDate ? `All day, ${formatYmdShort(e.startDate)} to ${formatYmdShort(last)}` : `All day, ${formatYmdShort(e.startDate)}`;
  }
  const sameDay = formatInstantDay(e.startAt) === formatInstantDay(e.endAt);
  if (sameDay) return e.startAt === e.endAt ? `${formatInstantDay(e.startAt)}, ${formatClock(e.startAt)}` : `${formatInstantDay(e.startAt)}, ${formatClock(e.startAt)} to ${formatClock(e.endAt)}`;
  return `${formatInstantDay(e.startAt)}, ${formatClock(e.startAt)} to ${formatInstantDay(e.endAt)}, ${formatClock(e.endAt)}`;
}
