// Calendar section of the briefing (T-231a): today's meetings with flags, and the 7-day look-ahead's notable events.
// Works on metadata from core.briefing_events only. "Owner" = the lane's own mailbox addresses (the connected accounts):
// their attendee response decides RSVP-pending and declined (declined events are hidden, cancelled never arrive).

import { httpsUrl } from "./url";

export type Attendee = { email: string; name: string | null; response: "accepted" | "declined" | "tentative" | "needs_action" | null };

export type BriefEvent = {
  key: string;
  connectionId: string | null;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  startDate: string | null;
  /** All-day events: the first date AFTER the event (exclusive), as the providers send it. */
  endDate: string | null;
  timezone: string | null;
  location: string | null;
  calendarUrl: string | null;
  meetingUrl: string | null;
  organizerEmail: string | null;
  attendees: Attendee[];
  calendarId: string;
};

export type DayEvent = BriefEvent & {
  rsvpPending: boolean;
  /** Titles of other events that overlap this one. */
  clashesWith: string[];
  /** Starts within the back-to-back gap after the previous event ends. */
  backToBack: boolean;
  /** Attendees outside the internal domains (addresses only). */
  external: string[];
};

export type NotableEvent = BriefEvent & { why: string[] };

/** Gap (minutes) under which two consecutive meetings count as back-to-back. */
export const BACK_TO_BACK_MINUTES = 5;

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const instant = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const RESPONSES = new Set(["accepted", "declined", "tentative", "needs_action"]);

function attendeesOf(v: unknown): Attendee[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a: Record<string, unknown>) =>
    a && typeof a.email === "string"
      ? [{ email: a.email.toLowerCase(), name: text(a.name), response: typeof a.response === "string" && RESPONSES.has(a.response) ? (a.response as Attendee["response"]) : null }]
      : [],
  );
}

/** Parses core.briefing_events rows; rows without times are dropped. */
export function parseEvents(rows: unknown): BriefEvent[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r: Record<string, unknown>) => {
    const startAt = instant(r.start_at);
    const endAt = instant(r.end_at);
    if (!startAt || !endAt) return [];
    const calendarId = typeof r.calendar_id === "string" ? r.calendar_id : "";
    return [
      {
        key: `${calendarId}:${typeof r.event_id === "string" ? r.event_id : startAt}`,
        connectionId: typeof r.connection_id === "string" ? r.connection_id : null,
        title: text(r.title) ?? "(No title)",
        startAt,
        endAt,
        allDay: r.all_day === true,
        startDate: typeof r.start_date === "string" ? r.start_date : null,
        endDate: typeof r.end_date === "string" ? r.end_date : null,
        timezone: text(r.timezone),
        location: text(r.location),
        calendarUrl: httpsUrl(r.source_url),
        meetingUrl: httpsUrl(r.online_meeting_url),
        organizerEmail: typeof r.organizer_email === "string" ? r.organizer_email.toLowerCase() : null,
        attendees: attendeesOf(r.attendees),
        calendarId,
      },
    ];
  });
}

/** The domain of an address: everything after the LAST "@" (lower-case), "" when there is none. The one definition; never split on the first "@". */
export const domainOf = (email: string): string => (email.lastIndexOf("@") < 0 ? "" : email.slice(email.lastIndexOf("@") + 1).toLowerCase());

export function ownResponse(e: BriefEvent, owners: ReadonlySet<string>): Attendee["response"] | "organizer" | null {
  const me = e.attendees.find((a) => owners.has(a.email));
  if (me) return me.response;
  if (e.organizerEmail && owners.has(e.organizerEmail)) return "organizer";
  return null;
}

export function externalAttendees(e: BriefEvent, owners: ReadonlySet<string>, internalDomains: ReadonlySet<string>): string[] {
  return e.attendees.filter((a) => !owners.has(a.email) && !internalDomains.has(domainOf(a.email)) && !isResource(a.email)).map((a) => a.email);
}

/** Google's public holiday calendars. */
export const isHoliday = (e: BriefEvent): boolean => /#holiday@group\.v\.calendar\.google\.com$/i.test(e.calendarId);

/**
 * Whether two events are one invitation seen through two connected calendars: same title and times, and not two
 * different meeting links. (A calendar page link differs per account, so it is not compared: that would stop the merge.)
 */
function sameInvitation(a: BriefEvent, b: BriefEvent): boolean {
  if (a.title !== b.title || a.startAt !== b.startAt || a.endAt !== b.endAt) return false;
  return !(a.meetingUrl && b.meetingUrl && a.meetingUrl !== b.meetingUrl);
}

/**
 * Today's events: declined ones hidden; timed events get clash and back-to-back flags (against other visible timed
 * events), RSVP-pending when the owner has not answered, and external attendees.
 */
export function analyzeDay(events: BriefEvent[], owners: ReadonlySet<string>, internalDomains: ReadonlySet<string>): DayEvent[] {
  // The same invitation can arrive once per connected calendar: show it once (same title and times), as summarizeAhead counts it.
  const seen: BriefEvent[] = [];
  const visible = events.filter((e) => {
    if (ownResponse(e, owners) === "declined") return false;
    if (seen.some((o) => sameInvitation(o, e))) return false;
    seen.push(e);
    return true;
  });
  const timed = visible.filter((e) => !e.allDay).sort((a, b) => a.startAt.localeCompare(b.startAt) || a.endAt.localeCompare(b.endAt));
  return visible.map((e) => {
    const s = Date.parse(e.startAt);
    const en = Date.parse(e.endAt);
    const clashesWith = e.allDay ? [] : timed.filter((o) => o !== e && Date.parse(o.startAt) < en && Date.parse(o.endAt) > s).map((o) => o.title);
    const prev = e.allDay ? undefined : timed.filter((o) => o !== e && Date.parse(o.endAt) <= s).sort((a, b) => b.endAt.localeCompare(a.endAt))[0];
    const backToBack = prev !== undefined && s - Date.parse(prev.endAt) <= BACK_TO_BACK_MINUTES * 60_000;
    return {
      ...e,
      rsvpPending: ownResponse(e, owners) === "needs_action",
      clashesWith: [...new Set(clashesWith)],
      backToBack,
      external: externalAttendees(e, owners, internalDomains),
    };
  });
}

/**
 * Look-ahead: events after today worth knowing about: holidays and other all-day events, meetings with external
 * attendees, and invitations still unanswered. Declined events are left out. At most `limit`, in time order.
 */
export function notableAhead(events: BriefEvent[], owners: ReadonlySet<string>, internalDomains: ReadonlySet<string>, limit = 8, known?: KnownNames): NotableEvent[] {
  const out: NotableEvent[] = [];
  for (const e of [...events].sort((a, b) => a.startAt.localeCompare(b.startAt))) {
    const resp = ownResponse(e, owners);
    if (resp === "declined") continue;
    const why: string[] = [];
    if (isHoliday(e)) why.push("Holiday");
    else if (e.allDay) why.push("All day");
    const ext = externalAttendees(e, owners, internalDomains);
    if (ext.length > 0) {
      const uniq = uniqueNames(ext, e, known);
      why.push(`External: ${uniq.slice(0, 2).join(", ")}${uniq.length > 2 ? ` +${String(uniq.length - 2)}` : ""}`);
    }
    if (resp === "needs_action") why.push("RSVP pending");
    if (why.length > 0) out.push({ ...e, why });
    if (out.length >= limit) break;
  }
  return out;
}

/** Calendar resources (rooms) and Google's own addresses are not people. */
const isResource = (email: string) => {
  const d = domainOf(email);
  return d === "calendar.google.com" || d.endsWith(".calendar.google.com");
};

/** Shared mailboxes are not people: shown as the local part, unchanged. */
const ROLE_MAILBOXES: ReadonlySet<string> = new Set(["info", "noreply", "no-reply", "sales", "support", "admin"]);

/** "dana.whitfield@x.com" -> "Dana Whitfield". Never the address itself. */
export function nameFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? "").replace(/\+.*$/, "");
  if (ROLE_MAILBOXES.has(local.toLowerCase())) return local;
  const words = local.split(/[._\-\s]+/).filter((w) => w !== "");
  if (words.length === 0) return "Guest";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/** Names we already hold for exact addresses (lower case), for example a `from_name` in the lane's mail index. */
export type KnownNames = ReadonlyMap<string, string>;

/**
 * How an attendee is shown (T-240). Never a name made up from the address's local part ("rnichols@" is not "Rnichols"):
 * 1. the display name on the event (when it is not itself an address), 2. a name we already hold for that exact address,
 * 3. the full email address. `real` = the name came from a person's own display name (it can dedupe by name and domain).
 */
function attendeeName(email: string, e: BriefEvent, known?: KnownNames): { name: string; real: boolean } {
  const n = e.attendees.find((x) => x.email === email)?.name?.trim().replace(/\s+/g, " ");
  if (n && !n.includes("@")) return { name: n, real: true };
  const k = known?.get(email.trim().toLowerCase())?.trim().replace(/\s+/g, " ");
  if (k && !k.includes("@")) return { name: k, real: true };
  return { name: email.trim(), real: false };
}

/** Attendee names (the address itself when no name is known), the owner's mailboxes and resources excluded: at most `max`, plus how many more. */
export function attendeeNames(e: BriefEvent, owners: ReadonlySet<string>, max = 3, known?: KnownNames): { names: string[]; more: number } {
  const others = e.attendees.filter((a) => !owners.has(a.email) && !isResource(a.email));
  const uniq = uniqueNames(
    others.map((a) => a.email),
    e,
    known,
  );
  return { names: uniq.slice(0, max), more: Math.max(0, uniq.length - max) };
}

/**
 * Display names for addresses, each person once (T-237). The same address (any case) is one person. Two entries with a real display
 * name are one person only when the name (case and whitespace insensitive) AND the email domain both match, so two "Sam"s at different
 * domains stay two and an external who is named like an internal colleague is never merged into them. An entry shown as its address
 * is no evidence of identity: it dedupes by full address only. The organizer is an attendee entry too.
 */
function uniqueNames(emails: readonly string[], e: BriefEvent, known?: KnownNames): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const email of emails) {
    const addr = email.trim().toLowerCase();
    const { name, real } = attendeeName(email, e, known);
    const domain = addr.slice(addr.lastIndexOf("@") + 1);
    const key = real ? `n:${name.toLowerCase()}|${domain}` : `a:${addr}`;
    if (seen.has(`a:${addr}`) || seen.has(key)) continue;
    seen.add(`a:${addr}`);
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** "Anna Lee, bob@x.test, Cy Wu +2 more" (a name, else the address; at most `max`). */
export function attendeeSummary(e: BriefEvent, owners: ReadonlySet<string>, max = 3, known?: KnownNames): string | null {
  const { names, more } = attendeeNames(e, owners, max, known);
  if (names.length === 0) return null;
  return more > 0 ? `${names.join(", ")} +${String(more)} more` : names.join(", ");
}

export type EventChip = { key: "clash" | "rsvp" | "back_to_back" | "external"; label: string; /** Longer text for a tooltip / screen readers. */ detail: string };

/** At most `max` chips, by priority: Clash, RSVP pending, Back-to-back, External. */
export function eventChips(e: DayEvent, max = 2): EventChip[] {
  const all: EventChip[] = [];
  if (e.clashesWith.length > 0) all.push({ key: "clash", label: "Clash", detail: `Clashes with ${e.clashesWith.join(", ")}` });
  if (e.rsvpPending) all.push({ key: "rsvp", label: "RSVP pending", detail: "You have not answered this invitation" });
  if (e.backToBack) all.push({ key: "back_to_back", label: "Back-to-back", detail: "Starts right after the previous meeting" });
  if (e.external.length > 0) all.push({ key: "external", label: "External", detail: "Has attendees outside your company" });
  return all.slice(0, max);
}

/** Meetings (timed, not declined) in the events and the number of clashing pairs among them. All-day events are not meetings. */
export function summarizeAhead(events: BriefEvent[], owners: ReadonlySet<string>): { meetings: number; clashes: number } {
  const seen: BriefEvent[] = [];
  // The same invitation can arrive once per connected calendar: count it once (same title and times, not different meeting links).
  const timed = events.filter((e) => {
    if (e.allDay || ownResponse(e, owners) === "declined") return false;
    if (seen.some((o) => sameInvitation(o, e))) return false;
    seen.push(e);
    return true;
  });
  let clashes = 0;
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i] as BriefEvent;
      const b = timed[j] as BriefEvent;
      if (Date.parse(a.startAt) < Date.parse(b.endAt) && Date.parse(b.startAt) < Date.parse(a.endAt)) clashes++;
    }
  }
  return { meetings: timed.length, clashes };
}

/** "12 meetings, 2 clashes" / "1 meeting" / "No meetings". */
export function aheadSummaryText(s: { meetings: number; clashes: number }): string {
  if (s.meetings === 0) return "No meetings";
  const m = `${String(s.meetings)} ${s.meetings === 1 ? "meeting" : "meetings"}`;
  return s.clashes > 0 ? `${m}, ${String(s.clashes)} ${s.clashes === 1 ? "clash" : "clashes"}` : m;
}

/** Mail providers whose domain says nothing about who is a colleague (never treated as internal). */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);

/**
 * Splits events into today and the following days by the VIEWER's local dates. All-day events go by their dates (the
 * sync stores their instants as midnight in the event's own zone, which is another day for a viewer elsewhere); timed
 * events by instant against [from, to). `days` = how many days after today the look-ahead covers.
 */
export function splitByDay(events: BriefEvent[], from: Date, to: Date, today: string, days: number): { today: BriefEvent[]; later: BriefEvent[] } {
  const end = (() => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days + 1);
    return d.toISOString().slice(0, 10);
  })();
  const out = { today: [] as BriefEvent[], later: [] as BriefEvent[] };
  for (const e of events) {
    if (e.allDay && e.startDate && e.endDate) {
      if (e.startDate <= today && e.endDate > today) out.today.push(e);
      else if (e.startDate > today && e.startDate < end) out.later.push(e);
    } else if (!e.allDay) {
      const s = Date.parse(e.startAt);
      if (s < to.getTime() && Date.parse(e.endAt) > from.getTime()) out.today.push(e);
      else if (s >= to.getTime()) out.later.push(e);
    }
  }
  return out;
}
