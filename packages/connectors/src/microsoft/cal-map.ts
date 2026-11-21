// The strict mapper of the Microsoft calendar sync (T-067, spec §9): one Graph event of `calendarView/delta` -> `EventMeta`, or a counted skip.
//
// Rule 6: no event body is ever stored. The calendarView delta does NOT support `$select` (documented), so Graph sends the whole event, `body` and
// `bodyPreview` included, on every page. Two layers keep that content out: this file's schema declares only the fields below, so `body`, `bodyPreview`,
// `onlineMeetingUrl` and everything else are dropped at parse time and never read (the page itself is held in memory only until the page is mapped); and the
// record is rebuilt field by field and checked by the strict `EventMetaSchema`, which has no field for a description. Graph content is untrusted (rule 9):
// text is clipped, cleaned (controls, line separators and bidi characters removed) and bounded exactly like the mail mapper; one bad address is dropped,
// never the event; nothing from a response is put in an error or a log line (the skip reasons are fixed words).
//
// Times: the sync sends `Prefer: outlook.timezone="UTC"`, so `start` and `end` are `dateTimeTimeZone` values in UTC. A `dateTime` without an offset is
// UTC. An event whose `timeZone` in the answer is NOT UTC is skipped and counted (`not_utc`), never converted by guess. Timed events need no zone table.
//
// All-day events: `start` and `end` are midnight in the event's own zone (documented), and Graph names that zone only as a WINDOWS name in
// `originalStartTimeZone`. The Windows-to-IANA table in ./cal-zones.ts is our own assumption; an all-day event whose zone is missing from it, is
// `tzone://Microsoft/Custom`, or whose instants are not that zone's local midnights is skipped and counted, never guessed. The EventMeta rule (instants =
// local midnight of the dates in `timezone`) is the final check.
//
// Cancelled events (`isCancelled: true`) become status stubs (ids, series link, version only): the page writer merges a stub's status without nulling the stored
// title, times or attendees, exactly as for Google's cancelled events.
import { z } from "zod";
import { isMailAddress } from "../comms/address";
import { EventMetaSchema, zonedMidnightMs, type Attendee, type EventMeta } from "../comms/schemas";
import { cleanText } from "../comms/text";
import type { MicrosoftCloud } from "./constants";
import { DEFAULT_CALENDAR_ID } from "./cal-cursor";
import { ianaForWindowsZone } from "./cal-zones";
import { instant, MAX_ID_CHARS, safeWebLink } from "./mail-map";

/** Microsoft's documented maximum of attendees per event. */
export const MAX_ATTENDEES = 500;
/** Serialized attendee lists above this are cut (the table allows 131,072 bytes), as the Google mapper does. */
const MAX_ATTENDEE_BYTES = 100_000;

/** Free text from other people: clipped while parsing (never rejected for length), then cleaned and cut to the table limits. */
const clip = (n: number) => z.string().transform((s) => s.slice(0, n));
const when = z.object({ dateTime: z.string().max(60).nullish(), timeZone: z.string().max(100).nullish() });
const emailAddress = z.object({ address: clip(512).nullish(), name: clip(800).nullish() }).nullish();

/** Only these keys are ever read. Everything else in a Graph event (body, bodyPreview, uniqueBody, onlineMeetingUrl, attachments...) is stripped by the parse. */
const GraphEventSchema = z.object({
  id: z.string().max(4096),
  iCalUId: clip(1024).nullish(),
  subject: clip(4000).nullish(),
  webLink: clip(4096).nullish(),
  isAllDay: z.boolean().nullish(),
  isCancelled: z.boolean().nullish(),
  type: z.string().max(40).nullish(),
  seriesMasterId: clip(1024).nullish(),
  start: when.nullish(),
  end: when.nullish(),
  originalStart: z.string().max(60).nullish(),
  originalStartTimeZone: z.string().max(100).nullish(),
  lastModifiedDateTime: z.string().max(60).nullish(),
  location: z.object({ displayName: clip(4000).nullish() }).nullish(),
  organizer: z.object({ emailAddress }).nullish(),
  attendees: z.array(z.object({ emailAddress, status: z.object({ response: z.string().max(40).nullish() }).nullish() })).max(5000).nullish(),
  onlineMeeting: z.object({ joinUrl: clip(4096).nullish() }).nullish(),
});

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const isCleanText = (s: string): boolean => cleanText(s) === s;

/** The skip reasons: fixed words, counted by the caller and logged without any event content. */
export type CalSkipReason = "invalid_item" | "series_master" | "not_utc" | "invalid_times" | "all_day_zone_unusable" | "invalid_all_day" | "invalid_event";
export type CalOutcome = { kind: "event"; meta: EventMeta } | { kind: "skip"; reason: CalSkipReason };

/** `{ calendar_id, event_id }` for an `@removed` entry with a usable id, else null (the caller counts it). */
export function removalOf(item: unknown): { calendar_id: string; event_id: string } | null {
  const id = (item as { id?: unknown } | null)?.id;
  return typeof id === "string" && id !== "" && id.length <= MAX_ID_CHARS && !CONTROL.test(id) ? { calendar_id: DEFAULT_CALENDAR_ID, event_id: id } : null;
}

function text(raw: string | null | undefined, max: number): string | null {
  if (raw === null || raw === undefined) return null;
  const t = cleanText(raw.slice(0, max * 4)).slice(0, max).trim();
  return t === "" ? null : t;
}

const RESPONSES: Record<string, Attendee["response"]> = { accepted: "accepted", declined: "declined", tentativelyAccepted: "tentative", notResponded: "needs_action", none: "needs_action" };

function attendeesOf(list: z.infer<typeof GraphEventSchema>["attendees"]): Attendee[] {
  const out: Attendee[] = [];
  let bytes = 0;
  for (const a of list ?? []) {
    const address = (a.emailAddress?.address ?? "").trim().toLowerCase();
    // Only the bad ADDRESS is dropped (as for mail); a hostile one never costs the rest of the event.
    if (address.length < 3 || address.length > 320 || !isCleanText(address) || !isMailAddress(address)) continue;
    const name = text(a.emailAddress?.name, 200);
    const response = a.status?.response ? RESPONSES[a.status.response] : undefined;
    const rec: Attendee = { email: address, ...(name !== null && name.toLowerCase() !== address ? { name } : {}), ...(response ? { response } : {}) };
    bytes += JSON.stringify(rec).length + 1;
    if (bytes > MAX_ATTENDEE_BYTES || out.length >= MAX_ATTENDEES) break;
    out.push(rec);
  }
  return out;
}

/** An https link of plain characters, at most 2048, with no credentials; else null. */
function httpsLink(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048 || !/^https:\/\/[\x21-\x7e]+$/.test(raw) || !URL.canParse(raw)) return null;
  const u = new URL(raw);
  return u.protocol === "https:" && u.username === "" && u.password === "" ? raw : null;
}

/** A `dateTimeTimeZone` of the UTC preference as epoch ms; `"not_utc"` when the answer names another zone; null when unusable. */
function utcMs(v: { dateTime?: string | null | undefined; timeZone?: string | null | undefined } | null | undefined): number | "not_utc" | null {
  if (!v || typeof v.dateTime !== "string") return null;
  if (typeof v.timeZone !== "string" || v.timeZone.toLowerCase() !== "utc") return "not_utc";
  const iso = instant(v.dateTime); // no offset means UTC
  return iso === null ? null : Date.parse(iso);
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** The calendar date (YYYY-MM-DD) of an instant in an IANA zone. */
function localDate(ms: number, tz: string): string {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    if (fmtCache.size > 64) fmtCache.clear();
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${String(p.year)}-${String(p.month)}-${String(p.day)}`;
}

export type CalMapContext = { cloud?: MicrosoftCloud };

/** One calendarView item as a record. Never throws; a skip carries a fixed reason and nothing of the event. */
export function mapEvent(raw: unknown, ctx: CalMapContext = {}): CalOutcome {
  const parsed = GraphEventSchema.safeParse(raw);
  if (!parsed.success) return { kind: "skip", reason: "invalid_item" };
  const e = parsed.data;
  if (e.id === "" || e.id.length > MAX_ID_CHARS || CONTROL.test(e.id)) return { kind: "skip", reason: "invalid_item" };
  // calendarView returns occurrences, exceptions and single instances, never the series master; one that shows up anyway would be a second copy of the first occurrence.
  if (e.type === "seriesMaster") return { kind: "skip", reason: "series_master" };

  const master = e.seriesMasterId ?? null;
  const recurring = master !== null && master !== "" && master.length <= MAX_ID_CHARS && !CONTROL.test(master) ? master : null;
  const version = instant(e.lastModifiedDateTime);
  const originalStart = recurring !== null ? instant(e.originalStart) : null;

  if (e.isCancelled === true) {
    const stub = EventMetaSchema.safeParse({
      calendar_id: DEFAULT_CALENDAR_ID,
      event_id: e.id,
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
      original_start_at: originalStart,
      online_meeting_url: null,
      source_updated_at: version,
    });
    return stub.success ? { kind: "event", meta: stub.data } : { kind: "skip", reason: "invalid_event" };
  }

  const startMs = utcMs(e.start);
  const endMs = utcMs(e.end);
  if (startMs === "not_utc" || endMs === "not_utc") return { kind: "skip", reason: "not_utc" };
  if (startMs === null || endMs === null) return { kind: "skip", reason: "invalid_times" };

  const zone = ianaForWindowsZone(e.originalStartTimeZone);
  let startDate: string | null = null;
  let endDate: string | null = null;
  const allDay = e.isAllDay === true;
  if (allDay) {
    if (zone === null) return { kind: "skip", reason: "all_day_zone_unusable" };
    try {
      startDate = localDate(startMs, zone);
      endDate = localDate(endMs, zone);
      // Midnight in the event's own zone, both ends (documented). Anything else is not understood, never guessed.
      if (zonedMidnightMs(startDate, zone) !== startMs || zonedMidnightMs(endDate, zone) !== endMs || endDate <= startDate) return { kind: "skip", reason: "invalid_all_day" };
    } catch {
      return { kind: "skip", reason: "all_day_zone_unusable" };
    }
  }

  const organizerAddress = (e.organizer?.emailAddress?.address ?? "").trim().toLowerCase();
  const organizerOk = organizerAddress.length >= 3 && organizerAddress.length <= 320 && isCleanText(organizerAddress) && isMailAddress(organizerAddress);
  const base = {
    calendar_id: DEFAULT_CALENDAR_ID,
    event_id: e.id,
    ical_uid: e.iCalUId && e.iCalUId.length <= MAX_ID_CHARS && !CONTROL.test(e.iCalUId) ? e.iCalUId : null,
    source_url: safeWebLink(e.webLink, ctx.cloud ?? "commercial"),
    title: text(e.subject, 1000),
    location: text(e.location?.displayName, 1000),
    organizer_email: organizerOk ? organizerAddress : null,
    organizer_name: text(e.organizer?.emailAddress?.name, 200),
    start_at: new Date(startMs).toISOString(),
    end_at: new Date(endMs).toISOString(),
    all_day: allDay,
    start_date: startDate,
    end_date: endDate,
    timezone: zone,
    attendees: attendeesOf(e.attendees),
    status: "confirmed" as const,
    recurring_event_id: recurring,
    original_start_at: originalStart,
    online_meeting_url: httpsLink(e.onlineMeeting?.joinUrl),
    source_updated_at: version,
  };
  // Other people's text broke a limit: clear ONLY the field that failed (never the whole record) and try again. The id, the times and the dates are ours to
  // keep, so a failure there is the only reason to drop the event.
  const CLEARABLE: Record<string, unknown> = { ical_uid: null, source_url: null, title: null, location: null, organizer_email: null, organizer_name: null, attendees: [], recurring_event_id: null, original_start_at: null, online_meeting_url: null, source_updated_at: null };
  let record: Record<string, unknown> = base;
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = EventMetaSchema.safeParse(record);
    if (r.success) return { kind: "event", meta: r.data };
    const keys = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? "")))];
    if (keys.some((k) => !(k in CLEARABLE) || JSON.stringify(record[k]) === JSON.stringify(CLEARABLE[k]))) return { kind: "skip", reason: allDay ? "invalid_all_day" : "invalid_event" };
    record = { ...record, ...Object.fromEntries(keys.map((k) => [k, CLEARABLE[k]])) };
  }
  return { kind: "skip", reason: "invalid_event" };
}
