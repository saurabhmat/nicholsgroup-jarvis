// Display rules for AI and masked text on Home (T-237 part D). Masking itself stays (rule 7: maskFigures / maskContent replace money amounts
// and long digit runs with "[amount]" / "[number]" before the text is stored or shown); the DISPLAY hides what the mask left behind:
// a field, line or sentence that contains a placeholder is dropped rather than shown. Also turns raw ISO date-times in model text into the
// viewer's time (America/New_York unless the viewer's zone says otherwise), never a trailing "Z".
import { formatDateTimeIn, validTimeZone } from "@nichols/briefing/domain";

const BUSINESS_TZ = "America/New_York";
const PLACEHOLDER = /\[(?:amount|number)\]/i;

/** True when the text still holds a masked-figure token. */
export const hasPlaceholder = (text: string | null | undefined): boolean => typeof text === "string" && PLACEHOLDER.test(text);

// 2026-11-12T14:00:00Z, 2026-11-12T14:00:00.000+00:00, 2026-11-12 14:00Z (seconds and fraction optional; a zone designator is required, as a bare local time has no zone to convert).
const ISO_DATETIME = /(?<![\w-])(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?\s?(Z|[+-]\d{2}:?\d{2})\b/g;

// A zone-less 2026-11-12T14:00:00 is read as New York wall time (the business zone), then shown like the others.
const ISO_LOCAL = /(?<![\w-])(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?![\d:]|\.\d|\s?(?:Z|[+-]\d{2}:?\d{2})\b)/g;
// Not part of a longer token: INV-2026-11-12 and 2026-11-12-draft stay as written.
const ISO_DATE = /(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w:-])/g;
const DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** The instant (ISO) of a wall-clock date and HH:MM in `tz` (two passes handle a DST offset change). Null when it does not parse. */
function zonedWallToInstant(d: string, hm: string, tz: string): string | null {
  const wall = Date.parse(`${d}T${hm}:00Z`);
  if (Number.isNaN(wall)) return null;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const offsetAt = (t: number): number => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - Math.floor(t / 60000) * 60000;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return new Date(t).toISOString();
}

/** Raw ISO instants in a model-written text become "Thu, Nov 12, 9:00 AM" in the viewer's zone; a bare ISO date becomes "Fri, Nov 13" (a calendar date, no zone shift). */
export function localizeTimes(text: string, tz: string): string {
  const zone = validTimeZone(tz) ?? BUSINESS_TZ;
  return text
    .replace(ISO_DATETIME, (m, d: string, hm: string, z: string) => {
      const zz = z === "Z" ? "Z" : z.includes(":") ? z : `${z.slice(0, 3)}:${z.slice(3)}`;
      const at = Date.parse(`${d}T${hm}:00${zz}`);
      return Number.isNaN(at) ? m : formatDateTimeIn(new Date(at).toISOString(), zone);
    })
    .replace(ISO_LOCAL, (m, d: string, hm: string) => {
      const at = zonedWallToInstant(d, hm, BUSINESS_TZ);
      return at === null ? m : formatDateTimeIn(at, zone);
    })
    .replace(ISO_DATE, (m, y: string, mo: string, d: string) => {
      const at = Date.parse(`${y}-${mo}-${d}T12:00:00Z`);
      return Number.isNaN(at) ? m : DAY.format(new Date(at));
    });
}

/** A one-value field (subject, why, next step, a priority, a deadline's due text): null when empty or when it holds a placeholder. */
export function fieldText(text: string | null | undefined, tz: string): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t === "" || hasPlaceholder(t)) return null;
  return localizeTimes(t, tz);
}

/** Running text (a summary line): the sentences with a placeholder are dropped, the rest kept; null when nothing is left. */
export function sentencesText(text: string | null | undefined, tz: string): string | null {
  if (typeof text !== "string") return null;
  const kept = text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim() !== "" && !hasPlaceholder(s));
  const out = kept.join(" ").trim();
  return out === "" ? null : localizeTimes(out, tz);
}
