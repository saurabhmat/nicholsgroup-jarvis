// Home v1 (T-200): today's meetings and the attention queue from data the lane has already synced. Read-only SQL through
// the signed-in user's lane client; the two `core.home_*` functions are SECURITY INVOKER, so RLS on cal/comms applies
// (AAL2 + lane membership + the calendar/comms view). Counts only for mail: no subject, sender or body reaches Home.
// The briefing (T-162), finance figures (T-095, needs D-8) and approvals (T-115) are not part of v1.
import type { Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";

const BUSINESS_TZ = "America/New_York";
const DAY_MS = 86_400_000;

export type HomeMeeting = {
  title: string;
  /** ISO instants; for an all-day event the start of its first day. */
  startAt: string;
  endAt: string;
  allDay: boolean;
  location: string | null;
  /** The event in Google Calendar (https only). */
  calendarUrl: string | null;
  /** The video-call link (https only). */
  meetingUrl: string | null;
};

export type AttentionItem = {
  key: string;
  label: string;
  /** Where it comes from, shown on the right ("Calendar", "Settings"...). */
  source: string;
  /** Lane-relative page segment ("settings", "calendar", "inbox"). */
  segment: string;
  count?: number;
};

/** From core.home_calendar_status: the caller's calendar view on the lane, and whether a calendar is connected. */
export type CalendarState = "connected" | "not_connected" | "no_access";

export type HomeView = {
  calendar: CalendarState;
  /** Today's meetings (empty unless `calendar` is "connected"). */
  meetings: HomeMeeting[];
  attention: AttentionItem[];
  /** Something could not be read; the page says so instead of showing an empty day. */
  unavailable?: true;
};

// ---------------------------------------------------------------------------------------------------------- time

function nyParts(at: Date): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: n("year"), m: n("month"), d: n("day"), hh: n("hour"), mm: n("minute"), ss: n("second") };
}

/** New York wall-clock offset from UTC at an instant, in ms (negative: behind UTC). */
function nyOffset(atMs: number): number {
  const p = nyParts(new Date(atMs));
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(atMs / 1000) * 1000;
}

/** The instant of 00:00 New York time on a calendar date (DST-safe: the offset is taken at midnight itself). */
function nyMidnight(y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - nyOffset(guess);
  return guess - nyOffset(first);
}

/** Today in the business time zone as [start, end): the window Home asks for. */
export function businessDay(now: Date): { from: Date; to: Date } {
  const p = nyParts(now);
  return { from: new Date(nyMidnight(p.y, p.m, p.d)), to: new Date(nyMidnight(p.y, p.m, p.d + 1)) };
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: BUSINESS_TZ });
export const formatTime = (iso: string) => TIME.format(new Date(iso));

// ---------------------------------------------------------------------------------------------------------- mapping

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

export function toMeetings(rows: unknown): HomeMeeting[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r: Record<string, unknown>) => {
    const startAt = instant(r.start_at);
    const endAt = instant(r.end_at);
    if (!startAt || !endAt) return [];
    return [
      {
        title: text(r.title) ?? "(No title)",
        startAt,
        endAt,
        allDay: r.all_day === true,
        location: text(r.location),
        calendarUrl: https(r.source_url),
        meetingUrl: https(r.online_meeting_url),
      },
    ];
  });
}

const PROVIDERS: Record<string, string> = { google: "Google", quickbooks: "QuickBooks", stripe: "Stripe", ghl: "GoHighLevel", gohighlevel: "GoHighLevel", monday: "monday.com" };
const providerName = (p: string) => PROVIDERS[p] ?? p;

type ConnectionRow = { id?: unknown; provider: unknown; status: unknown };
type MailCounts = { unread_important: number; unread_priority: number; priority_configured: boolean };

export function toAttention(input: { connections: ConnectionRow[]; meetings: HomeMeeting[]; mail: MailCounts | null; now: Date }): AttentionItem[] {
  const items: AttentionItem[] = [];
  input.connections.forEach((c, i) => {
    if (typeof c.provider !== "string") return;
    const key = `conn:${typeof c.id === "string" ? c.id : String(i)}`;
    if (c.status === "reconnect_required") items.push({ key, label: `${providerName(c.provider)} needs reconnecting`, source: "Settings", segment: "settings" });
    else if (c.status === "degraded") items.push({ key, label: `${providerName(c.provider)} connection has problems`, source: "Settings", segment: "settings" });
  });
  const next = input.meetings.find((m) => !m.allDay && Date.parse(m.startAt) > input.now.getTime());
  if (next) items.push({ key: "next-meeting", label: `Next: ${next.title} ${formatTime(next.startAt)}`, source: "Calendar", segment: "calendar" });
  if (input.mail && input.mail.unread_important > 0) {
    const n = input.mail.unread_important;
    items.push({ key: "mail-important", label: `${n} unread important ${n === 1 ? "email" : "emails"} in the last 24 hours`, source: "Inbox", segment: "inbox", count: n });
  }
  if (input.mail?.priority_configured && input.mail.unread_priority > 0) {
    const n = input.mail.unread_priority;
    items.push({ key: "mail-priority", label: `${n} unread from priority senders`, source: "Inbox", segment: "inbox", count: n });
  }
  return items;
}

function toCounts(data: unknown): MailCounts | null {
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return { unread_important: num(row.unread_important), unread_priority: num(row.unread_priority), priority_configured: row.priority_configured === true };
}

// ---------------------------------------------------------------------------------------------------------- loading

type Db = Pick<LaneClient, "schema">;

/** Home's data for one lane. Throws on a database error (the caller shows "unavailable", never an empty day). */
export async function loadHome(client: Db, laneId: string, now: Date): Promise<HomeView> {
  const core = client.schema("core");
  const { from, to } = businessDay(now);
  const since = new Date(now.getTime() - DAY_MS);
  const [conns, calendar, meetings, mail] = await Promise.all([
    core.from("connections").select("id, provider, status").eq("lane_id", laneId),
    core.rpc("home_calendar_status", { p_lane: laneId }),
    core.rpc("home_meetings", { p_lane: laneId, p_from: from.toISOString(), p_to: to.toISOString() }),
    core.rpc("home_mail_attention", { p_lane: laneId, p_since: since.toISOString() }),
  ]);
  const failed = [conns.error && "connections", calendar.error && "calendar_status", meetings.error && "meetings", mail.error && "mail"].filter(Boolean);
  if (failed.length > 0) throw new HomeLoadError(failed.join(","));
  // Connections need the `connections` view (owner, admin_technical); others simply see no feed rows.
  const connections = (conns.data ?? []) as ConnectionRow[];
  const state: CalendarState = calendar.data === "connected" || calendar.data === "not_connected" ? calendar.data : "no_access";
  const list = state === "connected" ? toMeetings(meetings.data) : [];
  return { calendar: state, meetings: list, attention: toAttention({ connections, meetings: list, mail: toCounts(mail.data), now }) };
}

/** Which reads failed (names only: no data, no driver message). */
export class HomeLoadError extends Error {
  constructor(readonly parts: string) {
    super(`home data unavailable: ${parts}`);
    this.name = "HomeLoadError";
  }
}

/** The Home page's view; the lane gate (loadLane) has already run. An outage gives `unavailable`, not an empty day. */
export async function homeFor(g: Pick<Guards, "requireLane">, laneId: string, now = new Date(), load = loadHome): Promise<HomeView> {
  const { client } = await g.requireLane(laneId as Parameters<Guards["requireLane"]>[0]);
  try {
    return await load(client, laneId, now);
  } catch (e) {
    // Lane and which part failed only: no rows, no driver text, no tokens.
    console.error("[home] unavailable", { laneId, parts: e instanceof HomeLoadError ? e.parts : e instanceof Error ? e.name : typeof e });
    return { calendar: "no_access", meetings: [], attention: [], unavailable: true };
  }
}
