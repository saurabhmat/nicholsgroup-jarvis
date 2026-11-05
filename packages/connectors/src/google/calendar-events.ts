// Mapping of Google Calendar data to the T-062 records (T-064): calendar ids, event resources and the composite cursor.
// Everything here is pure and defensive: calendar text (titles, locations, names, links) is written by other people
// (rule 9), so every value is clipped BEFORE it is cleaned (linear work on bounded input), stripped of control and
// bidirectional characters, and checked against the same limits as cal.event_index. A value that does not fit is dropped
// (and the whole event only when it cannot be indexed without it); nothing here ever invents a time (no now() fallback).
// The description is never requested by sync and has no field in any record (rule 6).
import { createHash } from "node:crypto";
import { z } from "zod";
import { EventMetaSchema, zonedMidnightMs, type Attendee, type EventMeta } from "../comms/schemas";
import { ConnectorError } from "../contract/errors";
import { MAX_CALENDARS } from "./constants";
import { cleanText } from "./headers";
import { cut } from "./mime";

// ---------------------------------------------------------------- calendar ids

/**
 * Stored/parameter form of a Google calendar id (decided in T-064). Google ids hold characters the T-062 id-parameter
 * rule refuses (`#` in holiday and contacts calendars) or that must not reach a URL raw. The encoded form keeps
 * `A-Z a-z 0-9 _ @ . + : -` and writes every other UTF-8 byte as `=` plus two upper-case hex digits (so `#` is `=23` and
 * a literal `=` is `=3D`). It is reversible, always matches `ProviderIdParamSchema`, and the primary calendar is stored
 * as the alias `primary` (stable, and it does not repeat the mailbox address in every row).
 */
export const PRIMARY_CALENDAR = "primary";
export const MAX_ENCODED_CALENDAR_ID = 200;
const SAFE_BYTE = /^[A-Za-z0-9_@.+:-]$/;
const ENCODED = /^(?:[A-Za-z0-9_@.+:-]|=[0-9A-F]{2}){1,600}$/;

/** The encoded form, or null when the id is empty, has control characters or is too long to store. */
export function encodeCalendarId(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_ENCODED_CALENDAR_ID || /[\u0000-\u001f\u007f-\u009f]/.test(raw)) return null;
  let out = "";
  for (const byte of new TextEncoder().encode(raw)) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && SAFE_BYTE.test(ch) ? ch : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    if (out.length > MAX_ENCODED_CALENDAR_ID) return null;
  }
  return out === "." || out === ".." ? null : out;
}

/** The raw Google id for an encoded one; null when it is not a well-formed encoded id. */
export function decodeCalendarId(encoded: string): string | null {
  if (!ENCODED.test(encoded)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "=") {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(encoded.charCodeAt(i));
  }
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    if (/[\u0000-\u001f\u007f-\u009f]/.test(raw) || raw === "." || raw === "..") return null;
    // Bijection: only the canonical encoding decodes (no lower-case hex, no escaped safe characters, no second spelling).
    return encodeCalendarId(raw) === encoded ? raw : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- calendar list

const CalendarEntrySchema = z.object({
  id: z.string().min(1).max(1024),
  primary: z.boolean().optional(),
  accessRole: z.string().max(32).optional(),
  selected: z.boolean().optional(),
  deleted: z.boolean().optional(),
});
export const CalendarListPageSchema = z.object({ items: z.array(z.unknown()).max(1000).optional(), nextPageToken: z.string().max(2048).optional() });

export type SelectedCalendar = { id: string; raw: string };

/**
 * Which calendars to sync. Default (conservative): the primary calendar plus calendars the user owns or can write to AND
 * shows (`selected`). Read-only calendars (holidays, other people's, subscribed) are left out unless
 * `includeReadOnly`; an explicit `calendarIds` list replaces the default (only listed ids, any role that can read events).
 * Primary first, then by encoded id; at most MAX_CALENDARS. Entries whose id cannot be encoded are dropped (`dropped`).
 */
export function selectCalendars(
  entries: readonly unknown[],
  settings: { calendarIds: readonly string[] | null; includeReadOnly: boolean },
): { calendars: SelectedCalendar[]; dropped: number } {
  const picked = new Map<string, SelectedCalendar>();
  let dropped = 0;
  for (const entry of entries) {
    const e = CalendarEntrySchema.safeParse(entry);
    if (!e.success || e.data.deleted === true) continue;
    const role = e.data.accessRole;
    const canRead = role === "owner" || role === "writer" || role === "reader";
    if (!canRead) continue; // freeBusyReader sees no details; an unknown role is not trusted
    let include: boolean;
    if (settings.calendarIds !== null) {
      include = settings.calendarIds.includes(e.data.id) || (e.data.primary === true && settings.calendarIds.includes(PRIMARY_CALENDAR));
    } else if (e.data.primary === true) {
      include = true;
    } else {
      include = e.data.selected === true && (role === "owner" || role === "writer" || settings.includeReadOnly);
    }
    if (!include) continue;
    const id = e.data.primary === true ? PRIMARY_CALENDAR : encodeCalendarId(e.data.id);
    if (id === null) {
      dropped += 1;
      continue;
    }
    if (!picked.has(id)) picked.set(id, { id, raw: e.data.primary === true ? PRIMARY_CALENDAR : e.data.id });
  }
  const all = [...picked.values()].sort((a, b) => (a.id === PRIMARY_CALENDAR ? -1 : b.id === PRIMARY_CALENDAR ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  dropped += Math.max(0, all.length - MAX_CALENDARS);
  return { calendars: all.slice(0, MAX_CALENDARS), dropped };
}

// ---------------------------------------------------------------- time

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    if (fmtCache.size > 64) fmtCache.clear();
    fmtCache.set(tz, f);
  }
  return f;
}
const TZ = /^[A-Za-z0-9_+./-]{1,64}$/;

/** `tz` when it is a usable IANA zone name (Intl knows it); else null. */
export function validTimeZone(tz: string | undefined | null): string | null {
  if (typeof tz !== "string" || !TZ.test(tz)) return null;
  try {
    zonedMidnightMs("2026-01-01", tz);
    return tz;
  } catch {
    return null;
  }
}

/** Epoch ms of a wall-clock time in an IANA zone (the earlier instant when the time repeats, a forward shift when it does not exist). */
function zonedLocalMs(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const fmt = formatter(tz);
  const offset = (utc: number): number => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(utc)).map((p) => [p.type, Number(p.value)]));
    return Date.UTC(parts.year as number, (parts.month as number) - 1, parts.day as number, parts.hour as number, parts.minute as number, parts.second as number) - Math.floor(utc / 1000) * 1000;
  };
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  return guess - offset(guess - offset(guess));
}

const DATE_TIME = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)?$/;
const DATE_ONLY = /^\d{4}-\d\d-\d\d$/;

const WhenSchema = z.object({ date: z.string().max(10).optional(), dateTime: z.string().max(40).optional(), timeZone: z.string().max(64).optional() });
type When = z.infer<typeof WhenSchema>;

/** An RFC 3339 instant (offset given, or resolved in `when.timeZone` / `fallbackTz` when it has none) as epoch ms; null when unusable. */
function instantMs(when: When | undefined, fallbackTz: string | null): number | null {
  const s = when?.dateTime;
  if (s === undefined) return null;
  const m = DATE_TIME.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, frac, off] = m as unknown as [string, string, string, string, string, string, string, string | undefined, string | undefined];
  const ms = Number(((frac ?? "0") + "00").slice(0, 3));
  let t: number;
  if (off !== undefined) {
    t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}.${String(ms).padStart(3, "0")}${off}`);
  } else {
    const tz = validTimeZone(when?.timeZone) ?? fallbackTz;
    if (tz === null) return null;
    t = zonedLocalMs(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(sec), tz) + ms;
  }
  return Number.isFinite(t) ? t : null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------- events

/** Free text from other people: clipped while parsing (never rejected for length), then cleaned and cut to the table limits. */
const clip = (n: number) => z.string().transform((s) => s.slice(0, n));

const EventItemSchema = z.object({
  id: z.string().min(1).max(1024),
  status: z.string().max(32).optional(),
  htmlLink: clip(4096).optional(),
  updated: z.string().max(40).optional(),
  // `description` and `attachments` are deliberately not declared: zod drops them, so content can never reach a record.
  summary: clip(4000).optional(),
  location: clip(4000).optional(),
  organizer: z.object({ email: clip(512).optional(), displayName: clip(800).optional() }).optional(),
  start: WhenSchema.optional(),
  end: WhenSchema.optional(),
  recurringEventId: clip(1024).optional(),
  originalStartTime: WhenSchema.optional(),
  iCalUID: clip(1024).optional(),
  attendees: z
    .array(z.object({ email: clip(512).optional(), displayName: clip(800).optional(), responseStatus: clip(32).optional() }))
    .max(5000)
    .optional(),
  hangoutLink: clip(4096).optional(),
  conferenceData: z.object({ entryPoints: z.array(z.object({ entryPointType: clip(32).optional(), uri: clip(4096).optional() })).max(50).optional() }).optional(),
});
export type EventItem = z.infer<typeof EventItemSchema>;

export const EventsPageSchema = z.object({
  items: z.array(z.unknown()).max(5000).optional(),
  nextPageToken: z.string().max(2048).optional(),
  nextSyncToken: z.string().max(2048).optional(),
  timeZone: z.string().max(64).optional(),
});

/** Clipped before cleaned: the work is linear in `max`, not in what the sender wrote. */
function text(raw: string | undefined, max: number): string | null {
  if (raw === undefined) return null;
  const t = cut(cleanText(raw.slice(0, max * 4)), max).text.trim();
  return t === "" ? null : t;
}
function link(raw: string | undefined): string | null {
  if (raw === undefined || raw.length > 2048 || !/^https:\/\/[^\s\u0000-\u001f\u007f]+$/.test(raw)) return null;
  return raw;
}
const RESPONSES: Record<string, Attendee["response"]> = { accepted: "accepted", declined: "declined", tentative: "tentative", needsAction: "needs_action" };
const EMAILISH = /^[^\s@\u0000-\u001f\u007f-\u009f]{1,64}@[^\s@\u0000-\u001f\u007f-\u009f]{1,255}$/;
/** Serialized attendee lists above this are cut (the table allows 131072 bytes). */
const MAX_ATTENDEE_BYTES = 100_000;

function attendeesOf(item: EventItem, withNames: boolean): Attendee[] {
  const out: Attendee[] = [];
  let bytes = 0;
  for (const a of item.attendees ?? []) {
    const email = a.email?.trim().toLowerCase();
    if (email === undefined || !EMAILISH.test(email) || email.length > 320) continue;
    const name = withNames ? text(a.displayName, 200) : null;
    const response = a.responseStatus !== undefined ? RESPONSES[a.responseStatus] : undefined;
    const rec: Attendee = { email, ...(name ? { name } : {}), ...(response ? { response } : {}) };
    bytes += JSON.stringify(rec).length + 1;
    if (bytes > MAX_ATTENDEE_BYTES || out.length >= 500) break;
    out.push(rec);
  }
  return out;
}

export type EventOutcome = { kind: "event"; meta: EventMeta } | { kind: "skip"; reason: string };

/**
 * One events.list item as a record. `calendarId` is the stored (encoded) id, `calendarTz` the calendar's own zone from
 * the response (used for all-day events, which have no zone of their own). Cancelled items become stubs (ids, version,
 * recurrence link only: the provider sends nothing else and the apply merges status only).
 */
export function toEventMeta(calendarId: string, calendarTz: string | null, raw: unknown): EventOutcome {
  const parsed = EventItemSchema.safeParse(raw);
  if (!parsed.success) return { kind: "skip", reason: "invalid_item" };
  const item = parsed.data;
  const updatedMs = item.updated !== undefined ? Date.parse(item.updated) : NaN;
  const version = Number.isFinite(updatedMs) ? iso(updatedMs) : null;
  const recurring = item.recurringEventId !== undefined && item.recurringEventId.length <= 512 ? item.recurringEventId : null;

  if (item.status === "cancelled") {
    const orig = item.originalStartTime;
    let originalStart: string | null = null;
    if (orig?.dateTime !== undefined) {
      const ms = instantMs(orig, calendarTz);
      originalStart = ms === null ? null : iso(ms);
    } else if (orig?.date !== undefined && DATE_ONLY.test(orig.date) && calendarTz !== null) {
      try {
        originalStart = iso(zonedMidnightMs(orig.date, calendarTz));
      } catch {
        originalStart = null;
      }
    }
    const stub = EventMetaSchema.safeParse({
      calendar_id: calendarId,
      event_id: item.id,
      ical_uid: null,
      source_url: null,
      title: null,
      location: null,
      organizer_email: null,
      organizer_name: null,
      start_at: null,
      end_at: null,
      all_day: false,
      start_date: null,
      end_date: null,
      timezone: null,
      attendees: [],
      status: "cancelled",
      recurring_event_id: recurring,
      original_start_at: recurring !== null ? originalStart : null,
      online_meeting_url: null,
      source_updated_at: version,
    });
    return stub.success ? { kind: "event", meta: stub.data } : { kind: "skip", reason: "invalid_stub" };
  }

  const status = item.status === undefined || item.status === "confirmed" ? "confirmed" : item.status === "tentative" ? "tentative" : null;
  if (status === null) return { kind: "skip", reason: "unknown_status" };

  const allDay = item.start?.date !== undefined;
  let startAt: number | null;
  let endAt: number | null;
  let startDate: string | null = null;
  let endDate: string | null = null;
  let timezone: string | null;
  if (allDay) {
    // All-day: calendar dates (end exclusive, as Google sends them), instants = local midnight in the calendar's zone.
    const tz = calendarTz ?? validTimeZone(item.start?.timeZone);
    if (tz === null) return { kind: "skip", reason: "all_day_without_timezone" };
    const sd = item.start?.date;
    const ed = item.end?.date;
    if (sd === undefined || ed === undefined || !DATE_ONLY.test(sd) || !DATE_ONLY.test(ed) || ed <= sd) return { kind: "skip", reason: "invalid_all_day" };
    try {
      startAt = zonedMidnightMs(sd, tz);
      endAt = zonedMidnightMs(ed, tz);
    } catch {
      return { kind: "skip", reason: "invalid_all_day" };
    }
    startDate = sd;
    endDate = ed;
    timezone = tz;
  } else {
    startAt = instantMs(item.start, calendarTz);
    endAt = instantMs(item.end, calendarTz);
    if (startAt === null || endAt === null) return { kind: "skip", reason: "invalid_times" };
    timezone = validTimeZone(item.start?.timeZone) ?? calendarTz;
  }
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) return { kind: "skip", reason: "invalid_times" };

  let originalStart: string | null = null;
  if (recurring !== null && item.originalStartTime) {
    if (item.originalStartTime.dateTime !== undefined) {
      const ms = instantMs(item.originalStartTime, calendarTz);
      originalStart = ms === null ? null : iso(ms);
    } else if (item.originalStartTime.date !== undefined && DATE_ONLY.test(item.originalStartTime.date) && timezone !== null) {
      try {
        originalStart = iso(zonedMidnightMs(item.originalStartTime.date, timezone));
      } catch {
        originalStart = null;
      }
    }
  }

  const entry = item.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video" && link(p.uri) !== null);
  const email = item.organizer?.email?.trim().toLowerCase();
  const build = (free: boolean) => ({
    calendar_id: calendarId,
    event_id: item.id,
    ical_uid: item.iCalUID !== undefined && item.iCalUID.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/.test(item.iCalUID) ? item.iCalUID : null,
    source_url: free ? link(item.htmlLink) : null,
    title: free ? text(item.summary, 1000) : null,
    location: free ? text(item.location, 1000) : null,
    organizer_email: email !== undefined && EMAILISH.test(email) && email.length <= 320 ? email : null,
    organizer_name: free ? text(item.organizer?.displayName, 200) : null,
    start_at: iso(startAt as number),
    end_at: iso(endAt as number),
    all_day: allDay,
    start_date: startDate,
    end_date: endDate,
    timezone,
    attendees: attendeesOf(item, free),
    status,
    recurring_event_id: recurring,
    original_start_at: originalStart,
    online_meeting_url: free ? (link(item.hangoutLink) ?? link(entry?.uri)) : null,
    source_updated_at: version,
  });
  // Other people's text broke a limit: keep the event with the unusable parts dropped rather than wedge the sync.
  const first = EventMetaSchema.safeParse(build(true));
  if (first.success) return { kind: "event", meta: first.data };
  const second = EventMetaSchema.safeParse(build(false));
  return second.success ? { kind: "event", meta: second.data } : { kind: "skip", reason: "invalid_event" };
}

// ---------------------------------------------------------------- composite cursor

/**
 * One cursor per connection (`g1.<connection id>.c:<base64url of the state>`), bound to the connection like the Gmail one.
 * The state is the run position `i` (the calendar being read) and, per calendar: `t` the syncToken of its last complete
 * read (null = it still needs its first full load), `pt` the page token of a read in progress, and `from`/`to` (epoch
 * days) the window of its full load (kept for page tokens, which are only valid with the same window, and to see when
 * the forward horizon has run short). A cursor with i = 0 and no page token is "caught up".
 */
const TOKEN = /^[A-Za-z0-9_=+/.%~:-]{1,700}$/;
const CalSchema = z.strictObject({
  id: z.string().regex(ENCODED).max(MAX_ENCODED_CALENDAR_ID),
  t: z.string().regex(TOKEN).nullable(),
  pt: z.string().regex(TOKEN).nullable(),
  from: z.int().min(0).max(1_000_000),
  to: z.int().min(0).max(1_000_000),
});
export type CalState = z.infer<typeof CalSchema>;
const StateSchema = z
  .strictObject({
    i: z.int().min(0).max(MAX_CALENDARS),
    cals: z.array(CalSchema).max(MAX_CALENDARS),
    /** True once this run's discovery (calendarList) has been done: the cursor is mid-run. False = the next call discovers. */
    d: z.boolean(),
    /** Fingerprint of the lane's calendar selection settings at discovery; a change mid-run triggers a new discovery. */
    s: z.string().regex(/^[0-9a-f]{12}$/),
  })
  .refine((s) => (s.cals.length === 0 ? s.i === 0 : s.i < s.cals.length), "position outside the calendar list")
  .refine((s) => s.cals.every((c, k) => c.pt === null || k === s.i), "only the current calendar can be mid-page")
  .refine((s) => new Set(s.cals.map((c) => c.id)).size === s.cals.length, "duplicate calendar");
export type CursorState = z.infer<typeof StateSchema>;

const CURSOR_RE = /^g1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.c:([A-Za-z0-9_-]{1,16384})$/;
const MAX_CURSOR = 16_384;

/** Short fingerprint of the settings that decide WHICH calendars are synced (not the look-ahead). */
export function selectionFingerprint(settings: { calendarIds: readonly string[] | null; includeReadOnly: boolean }): string {
  const ids = settings.calendarIds === null ? null : [...settings.calendarIds].sort();
  return createHash("sha256").update(JSON.stringify([ids, settings.includeReadOnly])).digest("hex").slice(0, 12);
}

export function isToken(s: string): boolean {
  return TOKEN.test(s);
}

/** The state when the cursor is well-formed AND belongs to this connection; null otherwise (-> fullResyncRequired). */
export function parseCalendarCursor(value: string, connectionId: string): CursorState | null {
  if (value.length > MAX_CURSOR) return null;
  const m = CURSOR_RE.exec(value);
  if (!m || m[1] !== connectionId) return null;
  try {
    const parsed = StateSchema.safeParse(JSON.parse(Buffer.from(m[2] as string, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function encodeCalendarCursor(connectionId: string, state: CursorState): { value: string } {
  const value = `g1.${connectionId}.c:${Buffer.from(JSON.stringify(StateSchema.parse(state)), "utf8").toString("base64url")}`;
  if (value.length > MAX_CURSOR) throw new ConnectorError({ kind: "provider_error", message: "The calendar sync cursor is too large" });
  return { value };
}

export const epochDay = (ms: number): number => Math.floor(ms / 86_400_000);
export const dayStartIso = (day: number): string => iso(day * 86_400_000);
