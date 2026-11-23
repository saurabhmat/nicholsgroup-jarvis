// How Messages draws times (T-283): the app's existing display convention, America/New_York (rule 11), `en-US`, with "ET" named where a full time is shown (as the mail page does). Pure functions of
// their arguments (the caller passes "now"): nothing here reads the clock. No directive: server and client components use it.
const ET = "America/New_York";
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: ET });
const FULL = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: ET });
const DAY_KEY = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: ET });
const DAY_LABEL = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: ET });
const SHORT_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: ET });
const SHORT_DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: ET });
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: ET });

const ms = (iso: string): number => Date.parse(iso);

/** `2026-11-21` for the New York calendar day of a time (the day separator's key). */
export const dayKey = (iso: string): string => DAY_KEY.format(ms(iso));
export const dayLabel = (iso: string): string => DAY_LABEL.format(ms(iso));
/** "3:07 PM" */
export const clockTime = (iso: string): string => TIME.format(ms(iso));
/** "Nov 21, 2026, 3:07 PM ET" (a tooltip) */
export const fullTime = (iso: string): string => `${FULL.format(ms(iso))} ET`;

/** The chat list's time: today "3:07 PM", the last six days "Fri", earlier "Nov 21" (with the year when it is not this year). `nowMs` is passed in, after the data has loaded. */
export function listTime(iso: string, nowMs: number): string {
  const t = ms(iso);
  if (Number.isNaN(t)) return "";
  if (dayKey(iso) === DAY_KEY.format(nowMs)) return TIME.format(t);
  const age = nowMs - t;
  if (age >= 0 && age < 6 * 86_400_000) return WEEKDAY.format(t);
  return DAY_KEY.format(t).slice(0, 4) === DAY_KEY.format(nowMs).slice(0, 4) ? SHORT_DAY.format(t) : SHORT_DAY_YEAR.format(t);
}
