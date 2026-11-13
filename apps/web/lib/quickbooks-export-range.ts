// Date-range helpers for the QuickBooks error-log download (T-197). Pure and browser-safe. Days are America/New_York
// calendar days, like the export route; `to` is inclusive; the route allows at most 90 days (EXPORT_MAX_DAYS, kept in step here).
export const EXPORT_MAX_DAYS = 90;
export const DEFAULT_EXPORT_DAYS = 30;
const DAY_MS = 86_400_000;
const ET_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` of an instant, as an America/New_York calendar day. */
export function etDay(at: Date): string {
  return ET_DAY.format(at);
}

function dayNumber(value: string): number | null {
  const m = DATE.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d ? t / DAY_MS : null;
}

/** The last 30 days, ending today (America/New_York): 30 days inclusive. */
export function defaultExportRange(now: Date): { from: string; to: string } {
  const to = etDay(now);
  const n = dayNumber(to) as number;
  return { from: new Date((n - (DEFAULT_EXPORT_DAYS - 1)) * DAY_MS).toISOString().slice(0, 10), to };
}

export type RangeCheck = { ok: true } | { ok: false; message: string };
export function checkExportRange(from: string, to: string): RangeCheck {
  const a = dayNumber(from);
  const b = dayNumber(to);
  if (a === null || b === null) return { ok: false, message: "Pick a start and an end date." };
  if (b < a) return { ok: false, message: "The end date must not be before the start date." };
  if (b - a + 1 > EXPORT_MAX_DAYS) return { ok: false, message: `Pick at most ${EXPORT_MAX_DAYS} days at a time.` };
  return { ok: true };
}
