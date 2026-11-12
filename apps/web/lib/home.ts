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
  /** The next meetings after today (up to 4, within 7 days); Home shows them when nothing is left today. */
  upcoming: HomeMeeting[];
  /** Feeds the caller may see, by provider (empty for roles without the connections view). */
  feeds: { provider: string; status: string }[];
  /** Unread important inbox mail in the last 24 h; null when the caller may not see mail. */
  unreadImportant: number | null;
  attention: AttentionItem[];
  /** Something could not be read; the page says so instead of showing an empty day. */
  unavailable?: true;
};

// ---------------------------------------------------------------------------------------------------------- time

function nyParts(at: Date): {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
} {
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
  return {
    y: n("year"),
    m: n("month"),
    d: n("day"),
    hh: n("hour"),
    mm: n("minute"),
    ss: n("second"),
  };
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
  return {
    from: new Date(nyMidnight(p.y, p.m, p.d)),
    to: new Date(nyMidnight(p.y, p.m, p.d + 1)),
  };
}

const TIME = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: BUSINESS_TZ,
});
export const formatTime = (iso: string) => TIME.format(new Date(iso));
const DAY = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: BUSINESS_TZ,
});
/** "Mon, Nov 9" in the business time zone. */
export const formatDay = (iso: string) => DAY.format(new Date(iso));

// ---------------------------------------------------------------------------------------------------------- briefing

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/**
 * Today's briefing until the AI briefing (T-162): short sentences built only from the data on the page (no model, no
 * figures that are not counted in SQL). Empty when there is nothing the caller may see.
 */
export function composeBriefing(view: Pick<HomeView, "calendar" | "meetings" | "upcoming" | "feeds" | "unreadImportant">, now: Date): string[] {
  const out: string[] = [];
  if (view.calendar === "connected") {
    const timed = view.meetings.filter((m) => !m.allDay);
    const left = timedLeft(view.meetings, now);
    const next = view.upcoming[0];
    const nextLater = next ? ` Next is ${next.title} on ${formatDay(next.startAt)} at ${formatTime(next.startAt)}.` : "";
    if (view.meetings.length === 0) {
      out.push(next ? `No meetings today; next is ${next.title} on ${formatDay(next.startAt)} at ${formatTime(next.startAt)}.` : "No meetings today or in the next week.");
    } else if (left.length === 0) {
      out.push((timed.length > 0 ? `${plural(timed.length, "meeting", "meetings")} today, none left.` : "Only all-day events today.") + nextLater);
    } else {
      const current = left.find((m) => Date.parse(m.startAt) <= now.getTime());
      const following = left.find((m) => Date.parse(m.startAt) > now.getTime());
      const parts = [current ? `${current.title} is on now` : null, following ? `${current ? "then" : "next is"} ${following.title} at ${formatTime(following.startAt)}` : null].filter(Boolean);
      out.push(`${plural(left.length, "meeting", "meetings")} left today; ${parts.join(", ")}.`);
    }
  }
  if (view.unreadImportant !== null) {
    out.push(
      view.unreadImportant === 0 ? "No unread important email in the last 24 hours." : `${plural(view.unreadImportant, "unread important email", "unread important emails")} in the last 24 hours.`,
    );
  }
  if (view.feeds.length > 0) {
    const problems = view.feeds.filter((f) => f.status === "reconnect_required" || f.status === "degraded");
    const active = view.feeds.filter((f) => f.status === "active");
    if (problems.length > 0) out.push(`${listNames(problems.map((f) => providerName(f.provider)))} ${problems.length === 1 ? "needs" : "need"} attention in Settings.`);
    else if (active.length > 0) out.push(`${listNames(active.map((f) => providerName(f.provider)))} ${new Set(active.map((f) => f.provider)).size === 1 ? "is" : "are"} connected.`);
  }
  return out;
}

/** Timed meetings today that have not ended (a meeting in progress counts). All-day events are not "left". */
export function timedLeft(meetings: HomeMeeting[], now: Date): HomeMeeting[] {
  return meetings.filter((m) => !m.allDay && Date.parse(m.endAt) > now.getTime());
}

function listNames(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] ?? "";
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1] ?? ""}`;
}

// ---------------------------------------------------------------------------------------------------------- KPI tiles

export type HomeKpi = {
  key: string;
  label: string;
  bookBalance?: boolean;
  statusText: string;
  /** True when the source is not connected (or needs reconnecting): the tile offers a Connect link instead of waiting. */
  connect: boolean;
};

/**
 * The prototype's MRR and Paid subscribers tiles. No figures until the Stripe and GoHighLevel tasks land: each tile says why,
 * from the feeds the caller can see. Never sample numbers. Cash, AR > 30 and P&L come from QuickBooks (T-233, home-finance.ts).
 */
export function homeKpis(feeds: HomeView["feeds"]): HomeKpi[] {
  const of = (...p: string[]) => feeds.filter((f) => p.includes(f.provider) && f.status !== "disconnected");
  const broken = (p: string[]) => of(...p).length > 0 && of(...p).every((f) => f.status === "reconnect_required" || f.status === "degraded");
  const visible = feeds.length > 0;
  const text = (p: string[], name: string, waiting: string, missing: string) =>
    !visible ? "Not available yet" : broken(p) ? `Reconnect ${name} in Settings` : of(...p).length > 0 ? waiting : missing;
  return [
    {
      key: "mrr",
      label: "MRR",
      statusText: text(["stripe"], "Stripe", "Waiting for the Stripe sync", "Stripe not connected yet"),
      connect: visible && !(of("stripe").length > 0 && !broken(["stripe"])),
    },
    {
      key: "subscribers",
      label: "Paid subscribers",
      statusText: text(["ghl", "gohighlevel"], "GoHighLevel", "Waiting for the GoHighLevel sync", "GoHighLevel not connected yet"),
      connect: visible && !(of("ghl", "gohighlevel").length > 0 && !broken(["ghl", "gohighlevel"])),
    },
  ];
}

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

const PROVIDERS: Record<string, string> = {
  google: "Google",
  quickbooks: "QuickBooks",
  stripe: "Stripe",
  ghl: "GoHighLevel",
  gohighlevel: "GoHighLevel",
  monday: "monday.com",
};
const providerName = (p: string) => PROVIDERS[p] ?? p;

type ConnectionRow = { id?: unknown; provider: unknown; status: unknown };
type MailCounts = {
  unread_important: number;
  unread_priority: number;
  priority_configured: boolean;
};

export function toAttention(input: { connections: ConnectionRow[]; meetings: HomeMeeting[]; mail: MailCounts | null; now: Date }): AttentionItem[] {
  const items: AttentionItem[] = [];
  input.connections.forEach((c, i) => {
    if (typeof c.provider !== "string") return;
    const key = `conn:${typeof c.id === "string" ? c.id : String(i)}`;
    if (c.status === "reconnect_required")
      items.push({
        key,
        label: `${providerName(c.provider)} needs reconnecting`,
        source: "Settings",
        segment: "settings",
      });
    else if (c.status === "degraded")
      items.push({
        key,
        label: `${providerName(c.provider)} connection has problems`,
        source: "Settings",
        segment: "settings",
      });
  });
  const next = timedLeft(input.meetings, input.now)[0];
  if (next) {
    const onNow = Date.parse(next.startAt) <= input.now.getTime();
    items.push({
      key: "next-meeting",
      label: onNow ? `Now: ${next.title} until ${formatTime(next.endAt)}` : `Next: ${next.title} ${formatTime(next.startAt)}`,
      source: "Calendar",
      segment: "calendar",
    });
  }
  if (input.mail && input.mail.unread_important > 0) {
    const n = input.mail.unread_important;
    items.push({
      key: "mail-important",
      label: `${n} unread important ${n === 1 ? "email" : "emails"} in the last 24 hours`,
      source: "Inbox",
      segment: "inbox?filter=important",
      count: n,
    });
  }
  if (input.mail?.priority_configured && input.mail.unread_priority > 0) {
    const n = input.mail.unread_priority;
    items.push({
      key: "mail-priority",
      label: `${n} unread from priority senders`,
      source: "Inbox",
      segment: "inbox",
      count: n,
    });
  }
  return items;
}

function toCounts(data: unknown): MailCounts | null {
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    unread_important: num(row.unread_important),
    unread_priority: num(row.unread_priority),
    priority_configured: row.priority_configured === true,
  };
}

// ---------------------------------------------------------------------------------------------------------- loading

type Db = Pick<LaneClient, "schema">;

/** Home's data for one lane. Throws on a database error (the caller shows "unavailable", never an empty day). */
export async function loadHome(client: Db, laneId: string, now: Date): Promise<HomeView> {
  const core = client.schema("core");
  const { from, to } = businessDay(now);
  const since = new Date(now.getTime() - DAY_MS);
  const [conns, calendar, meetings, mail, later] = await Promise.all([
    core.from("connections").select("id, provider, status").eq("lane_id", laneId).eq("transport", "native"), // a Composio connection has no sync/index yet (T-219)
    core.rpc("home_calendar_status", { p_lane: laneId }),
    core.rpc("home_meetings", {
      p_lane: laneId,
      p_from: from.toISOString(),
      p_to: to.toISOString(),
    }),
    core.rpc("home_mail_attention", {
      p_lane: laneId,
      p_since: since.toISOString(),
    }),
    core.rpc("home_meetings", {
      p_lane: laneId,
      p_from: to.toISOString(),
      p_to: new Date(to.getTime() + 7 * DAY_MS).toISOString(),
    }),
  ]);
  const failed = [conns.error && "connections", calendar.error && "calendar_status", meetings.error && "meetings", mail.error && "mail"].filter(Boolean);
  // "Coming up" is optional: if it fails, Home still shows today.
  if (later.error) console.error("[home] upcoming unavailable", { laneId });
  if (failed.length > 0) throw new HomeLoadError(failed.join(","));
  // Connections need the `connections` view (owner, admin_technical); others simply see no feed rows.
  const connections = (conns.data ?? []) as ConnectionRow[];
  const state: CalendarState = calendar.data === "connected" || calendar.data === "not_connected" ? calendar.data : "no_access";
  const list = state === "connected" ? toMeetings(meetings.data) : [];
  const upcoming =
    state === "connected" && !later.error
      ? toMeetings(later.data)
          .filter((m) => !m.allDay)
          .slice(0, 4)
      : [];
  const counts = toCounts(mail.data);
  const feeds = connections.flatMap((c) => (typeof c.provider === "string" && typeof c.status === "string" && c.status !== "disconnected" ? [{ provider: c.provider, status: c.status }] : []));
  return {
    calendar: state,
    meetings: list,
    upcoming,
    feeds,
    // No counts row = the caller may not read this lane's mail (decided in SQL). A caller who sees feeds but no mail feed
    // gets nothing either, rather than a "0" about a mailbox that is not connected.
    unreadImportant: counts && (feeds.length === 0 || feeds.some((f) => f.provider === "google")) ? counts.unread_important : null,
    attention: toAttention({ connections, meetings: list, mail: counts, now }),
  };
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
    console.error("[home] unavailable", {
      laneId,
      parts: e instanceof HomeLoadError ? e.parts : e instanceof Error ? e.name : typeof e,
    });
    return {
      calendar: "no_access",
      meetings: [],
      upcoming: [],
      feeds: [],
      unreadImportant: null,
      attention: [],
      unavailable: true,
    };
  }
}
