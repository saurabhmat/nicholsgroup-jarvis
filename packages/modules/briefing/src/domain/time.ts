// Time helpers for the briefing (T-231a). Times are shown in the VIEWER's time zone; the event's (or sender's) own zone is
// added in brackets when its wall clock differs at that instant. Business dates stay America/New_York (rule 11).
export const BUSINESS_TZ = "America/New_York";

const ZONE_RE = /^[A-Za-z][A-Za-z0-9_+./-]{0,63}$/;

/** A usable IANA zone name, or null (unknown names, offsets and junk are refused). */
export function validTimeZone(tz: unknown): string | null {
  if (typeof tz !== "string" || !ZONE_RE.test(tz)) return null;
  try {
    // The canonical spelling, so "america/NEW_york" and "America/New_York" are one zone (and one cache key).
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = cache.get(key);
  if (!f) {
    if (cache.size >= 500) cache.clear(); // bounded: keys come from zone names
    f = make();
    cache.set(key, f);
  }
  return f;
}

/** "9:30 AM" in a zone. */
export const formatTimeIn = (iso: string, tz: string): string =>
  fmt(`t:${tz}`, () => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })).format(new Date(iso));

/** "Thu, Nov 12" in a zone. */
export const formatDayIn = (iso: string, tz: string): string =>
  fmt(`d:${tz}`, () => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz })).format(new Date(iso));

/** "Thu, Nov 12, 9:30 AM" in a zone. */
export const formatDateTimeIn = (iso: string, tz: string): string => `${formatDayIn(iso, tz)}, ${formatTimeIn(iso, tz)}`;

/** Short zone name at an instant ("PST", "GMT+1"). */
export const zoneAbbrev = (iso: string, tz: string): string =>
  fmt(`z:${tz}`, () => new Intl.DateTimeFormat("en-US", { timeZoneName: "short", timeZone: tz }))
    .formatToParts(new Date(iso))
    .find((p) => p.type === "timeZoneName")?.value ?? tz;

/** Wall-clock offset of a zone from UTC at an instant, in minutes. */
export function offsetMinutes(iso: string, tz: string): number {
  const d = new Date(iso);
  const parts = fmt(`o:${tz}`, () =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
  ).formatToParts(d);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"));
  return Math.round((wall - Math.floor(d.getTime() / 60_000) * 60_000) / 60_000);
}

/**
 * The time in the viewer's zone, plus the other zone when its clock differs at that instant:
 * "9:30 AM (6:30 AM PST)". Same offset (even under another name) adds nothing.
 */
export function timeWithZone(iso: string, viewerTz: string, otherTz: string | null): string {
  const base = formatTimeIn(iso, viewerTz);
  const other = otherTz ? validTimeZone(otherTz) : null;
  if (!other || offsetMinutes(iso, other) === offsetMinutes(iso, viewerTz)) return base;
  return `${base} (${formatTimeIn(iso, other)} ${zoneAbbrev(iso, other)})`;
}

/** [start, end) of the calendar day containing `now` in a zone (DST-safe). */
export function dayWindow(now: Date, tz: string): { from: Date; to: Date } {
  const parts = fmt(`p:${tz}`, () => new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })).formatToParts(now);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const midnight = (y: number, m: number, d: number) => {
    const guess = Date.UTC(y, m - 1, d);
    const first = guess - offsetMinutes(new Date(guess).toISOString(), tz) * 60_000;
    return guess - offsetMinutes(new Date(first).toISOString(), tz) * 60_000;
  };
  const y = n("year");
  const m = n("month");
  const d = n("day");
  return { from: new Date(midnight(y, m, d)), to: new Date(midnight(y, m, d + 1)) };
}

/** "2h ago", "3d ago", "just now". */
export function ago(iso: string, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${String(mins)} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${String(h)}h ago`;
  return `${String(Math.round(h / 24))}d ago`;
}

/** "YYYY-MM-DD" of an instant in a zone. */
export function localDate(at: Date, tz: string): string {
  const parts = fmt(`p:${tz}`, () => new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })).formatToParts(at);
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${v("year")}-${v("month")}-${v("day")}`;
}

/** A calendar date plus n days ("2026-11-12" + 1 = "2026-11-13"). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
