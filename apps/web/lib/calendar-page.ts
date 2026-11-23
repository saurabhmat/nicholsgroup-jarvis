// T-274: the Calendar page's data. Read-only SQL through the signed-in user's own lane client: core.home_calendar_status (does the caller have a calendar here)
// and core.calendar_events (the caller's own events of this lane, both providers, de-duplicated; RLS + the explicit own-mailbox filter), plus the caller's own
// Google and Microsoft connections for the legend. Nothing is written anywhere (rule 5); no event description is read or stored (rule 6); event text is
// untrusted (rule 9): it is shown as text, and only https links are kept. An error is "unavailable", never an empty calendar.
import type { Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import { httpsUrl, openInText, sourceLabel } from "@nichols/briefing/domain";
import { isYmd, type Period, type Span } from "./calendar-time";

/** The page shows at most this many events (the function returns one more, to say "more than shown"). */
export const EVENT_CAP = 500;
const PROVIDERS = ["google", "microsoft"] as const;
export type CalendarProvider = (typeof PROVIDERS)[number];

export type CalendarAccount = {
  id: string;
  provider: CalendarProvider;
  /** The account address ("" when unknown). */
  address: string;
  /** "Google Calendar · name@example.test" / "Outlook · name@example.test". */
  label: string;
  /** Needs the person's attention in Settings: null when it is fine. */
  problem: "reconnect" | "degraded" | null;
  /** Index into the page's palette. */
  colour: number;
};

export type CalendarEvent = Span & {
  key: string;
  title: string;
  /** The winning copy's connection; the colour and the account name come from it. */
  connectionId: string;
  provider: CalendarProvider;
  tentative: boolean;
  timezone: string | null;
  location: string | null;
  organizer: string | null;
  /** "Open in Google Calendar" / "Open in Outlook" target (https only). */
  calendarUrl: string | null;
  openLabel: string;
  /** The video-call link (https only). */
  meetingUrl: string | null;
};

export type CalendarData =
  | { state: "unavailable" }
  | { state: "no_access" }
  | { state: "not_connected" }
  | { state: "connected"; accounts: CalendarAccount[]; events: CalendarEvent[]; /** More events than the page shows. */ truncated: boolean };

export class CalendarLoadError extends Error {
  constructor(readonly parts: string) {
    super(`calendar data unavailable: ${parts}`);
    this.name = "CalendarLoadError";
  }
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const instant = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const isProvider = (v: unknown): v is CalendarProvider => v === "google" || v === "microsoft";

/** Rows to events: a row that lacks a valid time, provider or id is dropped (never shown wrong). */
export function toEvents(rows: unknown): CalendarEvent[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r: Record<string, unknown>, i) => {
    const startAt = instant(r.start_at);
    const endAt = instant(r.end_at);
    const connectionId = text(r.connection_id);
    if (!startAt || !endAt || !connectionId || !isProvider(r.provider)) return [];
    const allDay = r.all_day === true;
    const startDate = isYmd(r.start_date) ? r.start_date : null;
    const endDate = isYmd(r.end_date) ? r.end_date : null;
    if (allDay && (!startDate || !endDate || endDate <= startDate)) return [];
    const organizerName = text(r.organizer_name);
    const organizerEmail = text(r.organizer_email);
    return [
      {
        key: `${connectionId}:${text(r.calendar_id) ?? ""}:${text(r.event_id) ?? String(i)}`,
        title: text(r.title) ?? "(No title)",
        connectionId,
        provider: r.provider,
        tentative: r.status === "tentative",
        timezone: text(r.timezone),
        location: text(r.location),
        organizer: organizerName && organizerEmail ? `${organizerName} (${organizerEmail})` : (organizerName ?? organizerEmail),
        calendarUrl: httpsUrl(r.source_url),
        openLabel: openInText(r.provider, "calendar") ?? "Open",
        meetingUrl: httpsUrl(r.online_meeting_url),
        allDay,
        startAt,
        endAt,
        startDate: allDay ? startDate : null,
        endDate: allDay ? endDate : null,
      },
    ];
  });
}

/** The caller's accounts, in a stable order, each with its colour (an index into the palette). Disconnected ones are left out. */
export function toAccounts(rows: unknown): CalendarAccount[] {
  if (!Array.isArray(rows)) return [];
  const list = rows.flatMap((r: Record<string, unknown>) => {
    const id = text(r.id);
    if (!id || !isProvider(r.provider) || r.status === "disconnected") return [];
    const address = text(r.external_account_id) ?? "";
    return [{ id, provider: r.provider, address, status: r.status }];
  });
  list.sort((a, b) => a.provider.localeCompare(b.provider) || a.address.localeCompare(b.address) || a.id.localeCompare(b.id));
  return list.map((a, i) => ({
    id: a.id,
    provider: a.provider,
    address: a.address,
    label: sourceLabel({ provider: a.provider, account: a.address }, "calendar") ?? "Calendar",
    problem: a.status === "reconnect_required" ? "reconnect" : a.status === "degraded" ? "degraded" : null,
    colour: i,
  }));
}

/** An event whose connection is not in the legend (a connection the list did not return) still gets a label and a colour of its own, after the listed accounts. */
export function withStrays(accounts: CalendarAccount[], events: CalendarEvent[]): CalendarAccount[] {
  const known = new Set(accounts.map((a) => a.id));
  const out = [...accounts];
  for (const e of events) {
    if (known.has(e.connectionId)) continue;
    known.add(e.connectionId);
    out.push({ id: e.connectionId, provider: e.provider, address: "", label: sourceLabel({ provider: e.provider, account: "" }, "calendar") ?? "Calendar", problem: null, colour: out.length });
  }
  return out;
}

type Db = Pick<LaneClient, "schema">;

/** The page's data for one lane and window. Throws CalendarLoadError on any database error. */
export async function loadCalendar(client: Db, laneId: string, userId: string, period: Pick<Period, "from" | "to">): Promise<CalendarData> {
  const core = client.schema("core");
  const status = await core.rpc("home_calendar_status", { p_lane: laneId });
  if (status.error) throw new CalendarLoadError("calendar_status");
  if (status.data === "not_connected") return { state: "not_connected" };
  if (status.data !== "connected") return { state: "no_access" };
  const [conns, events] = await Promise.all([
    // The caller's OWN accounts (an owner or admin can read every connection's health; the legend is the person's calendars only). A Composio connection has no synced index.
    core
      .from("connections")
      .select("id, provider, status, external_account_id")
      .eq("lane_id", laneId)
      .eq("owner_user_id", userId)
      .eq("transport", "native")
      .in("provider", [...PROVIDERS]),
    core.rpc("calendar_events", { p_lane: laneId, p_from: period.from.toISOString(), p_to: period.to.toISOString() }),
  ]);
  const failed = [conns.error && "connections", events.error && "events"].filter(Boolean);
  if (failed.length > 0) throw new CalendarLoadError(failed.join(","));
  const all = toEvents(events.data);
  const rows = Array.isArray(events.data) ? events.data.length : 0;
  const shown = all.slice(0, EVENT_CAP);
  return { state: "connected", accounts: withStrays(toAccounts(conns.data), shown), events: shown, truncated: rows > EVENT_CAP };
}

/** The Calendar page's view; the lane gate (loadLane) has already run. An outage gives `unavailable`, never an empty calendar. */
export async function calendarFor(g: Pick<Guards, "requireLane">, laneId: string, period: Period, load = loadCalendar): Promise<CalendarData> {
  const { client, session } = await g.requireLane(laneId as Parameters<Guards["requireLane"]>[0]);
  try {
    return await load(client, laneId, session.userId, period);
  } catch (e) {
    console.error("[calendar] unavailable", { laneId, view: period.view, parts: e instanceof CalendarLoadError ? e.parts : e instanceof Error ? e.name : typeof e });
    return { state: "unavailable" };
  }
}
