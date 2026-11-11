// Calendar section of the briefing (T-231a): today's meetings with flags, and the 7-day look-ahead's notable events.
// Works on metadata from core.briefing_events only. "Owner" = the lane's own mailbox addresses (the connected accounts):
// their attendee response decides RSVP-pending and declined (declined events are hidden, cancelled never arrive).

export type Attendee = { email: string; name: string | null; response: "accepted" | "declined" | "tentative" | "needs_action" | null };

export type BriefEvent = {
  key: string;
  connectionId: string | null;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  startDate: string | null;
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

const https = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
};
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
        timezone: text(r.timezone),
        location: text(r.location),
        calendarUrl: https(r.source_url),
        meetingUrl: https(r.online_meeting_url),
        organizerEmail: typeof r.organizer_email === "string" ? r.organizer_email.toLowerCase() : null,
        attendees: attendeesOf(r.attendees),
        calendarId,
      },
    ];
  });
}

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

export function ownResponse(e: BriefEvent, owners: ReadonlySet<string>): Attendee["response"] | "organizer" | null {
  const me = e.attendees.find((a) => owners.has(a.email));
  if (me) return me.response;
  if (e.organizerEmail && owners.has(e.organizerEmail)) return "organizer";
  return null;
}

export function externalAttendees(e: BriefEvent, owners: ReadonlySet<string>, internalDomains: ReadonlySet<string>): string[] {
  return e.attendees.filter((a) => !owners.has(a.email) && !internalDomains.has(domainOf(a.email)) && !a.email.endsWith("calendar.google.com")).map((a) => a.email);
}

/** Holiday calendars (Google's public holiday calendars) or an all-day event on another shared calendar. */
export const isHoliday = (e: BriefEvent): boolean => /#holiday@group\.v\.calendar\.google\.com$/i.test(e.calendarId) || /holiday/i.test(e.calendarId);

/**
 * Today's events: declined ones hidden; timed events get clash and back-to-back flags (against other visible timed
 * events), RSVP-pending when the owner has not answered, and external attendees.
 */
export function analyzeDay(events: BriefEvent[], owners: ReadonlySet<string>, internalDomains: ReadonlySet<string>): DayEvent[] {
  const visible = events.filter((e) => ownResponse(e, owners) !== "declined");
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
export function notableAhead(events: BriefEvent[], owners: ReadonlySet<string>, internalDomains: ReadonlySet<string>, limit = 8): NotableEvent[] {
  const out: NotableEvent[] = [];
  for (const e of [...events].sort((a, b) => a.startAt.localeCompare(b.startAt))) {
    const resp = ownResponse(e, owners);
    if (resp === "declined") continue;
    const why: string[] = [];
    if (isHoliday(e)) why.push("Holiday");
    else if (e.allDay) why.push("All day");
    const ext = externalAttendees(e, owners, internalDomains);
    if (ext.length > 0) why.push(`External: ${ext.slice(0, 2).join(", ")}${ext.length > 2 ? ` +${String(ext.length - 2)}` : ""}`);
    if (resp === "needs_action") why.push("RSVP pending");
    if (why.length > 0) out.push({ ...e, why });
    if (out.length >= limit) break;
  }
  return out;
}

/** "Anna Lee, bob@x.com +3" (names first; at most `max`). */
export function attendeeSummary(e: BriefEvent, owners: ReadonlySet<string>, max = 3): string | null {
  const others = e.attendees.filter((a) => !owners.has(a.email) && !a.email.endsWith("calendar.google.com"));
  if (others.length === 0) return null;
  const shown = others.slice(0, max).map((a) => a.name ?? a.email);
  return others.length > max ? `${shown.join(", ")} +${String(others.length - max)}` : shown.join(", ");
}
