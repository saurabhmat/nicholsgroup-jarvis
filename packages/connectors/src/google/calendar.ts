// Google Calendar CalendarProvider (T-064): event metadata sync, live description, polling watch, prepareWrite unsupported.
// Read-only against Google by construction (the API client has GET only and www.googleapis.com is reachable only for the
// three Calendar paths in CALENDAR_PATHS). Implements the T-062 interface and passes its contract suite.
//
// Which calendars: `calendarList.list`, then the primary calendar plus calendars the user owns or can write to AND shows
// (selected). Holidays and other read-only calendars are left out unless `lane_config.calendar.include_read_only`; an
// explicit `lane_config.calendar.calendar_ids` list replaces the default (see calendar-events.ts for the id encoding).
// The primary calendar is stored as `primary`. Discovery runs at the start of every run, so a new, removed or unselected
// calendar is picked up on the next run (rows of a calendar that left the selection stay until retention purges them).
//
// Sync: `events.list` with singleEvents=true (recurring series arrive as instances) and a `fields` mask that leaves out
// the description, attendee photos, attachments and everything else the index does not keep. One API page per `sync`
// call. A calendar's first load covers [today - min(180, lane retention), today + forward_days] and asks for deleted
// events too (so a reload after a gap also cancels what was deleted meanwhile); afterwards each calendar uses its own
// syncToken, inside ONE composite cursor per connection (calendar-events.ts). A calendar whose forward horizon has run
// down to half is reloaded in full (the syncToken keeps the window of its first request).
//   410 Gone (expired syncToken) or a refused token => fullResyncRequired for the WHOLE connection: the run discards the
//   cursor and reloads every calendar. Per-calendar repair would need a way to clear one calendar's rows, which the
//   interface does not have; 410 is rare (tokens live about a week at least).
//   404 for a calendar (deleted or no longer shared since discovery) => that calendar is dropped from the cursor.
//
// Records (metadata only, rule 6): all-day events carry start_date/end_date (exclusive) and start_at/end_at = local
// midnight in the CALENDAR's zone (all-day events have none of their own); cancelled events are stubs (status only, the
// apply merges them without nulling stored fields); times are never invented (no now() fallback; an event that cannot be
// timed is skipped and counted in the log). source_updated_at = Google's `updated`.
//
// readBody is a live events.get with `fields=id,description`, converted to text, wrapped in UntrustedBody; nothing is
// stored or cached. Calendar push (events.watch) is not built: `watch` answers polling mode and creates no channel.
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { UntrustedBody } from "../comms/ephemeral";
import type { CalendarCapabilities, CalendarProvider } from "../comms/provider";
import {
  CalendarSyncResultSchema,
  CalendarWriteIntentSchema,
  CommsCursorSchema,
  CommsSyncOptionsSchema,
  ProviderIdParamSchema,
  ReadBodyOptionsSchema,
  type CalendarSyncResult,
  type CommsCursor,
  type EventMeta,
  type WatchInfo,
} from "../comms/schemas";
import { ConnectorError, isConnectorError } from "../contract/errors";
import type { LaneBoundConnection } from "../contract/lane-bound";
import type { ProposedPayload, SourceResult } from "../contract/schemas";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { LaneConfigReader } from "../vault/lane-config";
import type { GoogleApi } from "./api";
import {
  CalendarListPageSchema,
  decodeCalendarId,
  dayStartIso,
  encodeCalendarCursor,
  epochDay,
  EventsPageSchema,
  isToken,
  parseCalendarCursor,
  PRIMARY_CALENDAR,
  selectCalendars,
  selectionFingerprint,
  toEventMeta,
  validTimeZone,
  type CalState,
  type CursorState,
  type SelectedCalendar,
} from "./calendar-events";
import { DEFAULT_MAX_BODY_CHARS, EVENT_RETENTION_DAYS } from "./constants";
import { createProviderGuard } from "./guard";
import { cut, htmlToText } from "./mime";

export type GoogleCalendarProviderDeps = {
  api: GoogleApi;
  /** The authoritative connection row (status, lane, provider), read on every call. */
  connections: { load(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<string>> };
  /**
   * `mailboxes` is re-read on every sync and read (a mailbox removed from the lane stops working at once);
   * `retentionDays` bounds a full load to the lane policy and fails closed when unreadable; `calendarSettings` picks the
   * calendars and the look-ahead (malformed settings fail closed).
   */
  laneConfig: Pick<LaneConfigReader, "mailboxes" | "retentionDays" | "calendarSettings">;
  now?: () => number;
  logger?: ConnectorLogger;
};

const PATH_CALENDAR_LIST = "/calendar/v3/users/me/calendarList";
const PATH_EVENTS = "/calendar/v3/calendars/{calendarId}/events";
const PATH_EVENT = "/calendar/v3/calendars/{calendarId}/events/{eventId}";
const MAX_LIST_PAGES = 5;
const DEFAULT_PAGE_SIZE = 250;

/** Only what the index keeps. `description`, `attachments`, `attendeesOmitted`, `creator`, photos and the rest are not requested. */
const EVENT_FIELDS =
  "nextPageToken,nextSyncToken,timeZone,items(id,status,htmlLink,updated,summary,location,organizer(email,displayName),start,end,recurringEventId,originalStartTime,iCalUID,attendees(email,displayName,responseStatus),hangoutLink,conferenceData(entryPoints(entryPointType,uri)))";
const LIST_FIELDS = "nextPageToken,items(id,primary,accessRole,selected,deleted)";

const DescriptionSchema = z.object({ description: z.string().max(5_000_000).optional() });
const invalid = (message: string) => new ConnectorError({ kind: "invalid_input", message });
const bad = (message: string) => new ConnectorError({ kind: "provider_error", message });

export function createGoogleCalendarProvider(deps: GoogleCalendarProviderDeps): CalendarProvider<"google"> {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? connectorLog;
  const capabilities: CalendarCapabilities = { watch: "polling", prepareWrite: false };
  const guard = createProviderGuard({ connections: deps.connections, laneConfig: deps.laneConfig });

  const envelope = <T>(laneId: LaneId, conn: LaneBoundConnection<"google">, op: string, data: T): SourceResult<T, "google"> => {
    const at = new Date(now()).toISOString();
    return { lane_id: laneId, provider: "google", connection_id: conn.id, op, data, as_of: at, fetched_at: at, freshness: "live", provider_tid: null, source_refs: [], notes: [] };
  };

  /**
   * The calendars this connection syncs right now (calendarList, filtered by the lane's settings). A partial read is an
   * error, never a shorter list: a calendar missing from a partial list would look "unselected" and have its rows dropped.
   */
  async function discover(laneId: LaneId, conn: LaneBoundConnection<"google">, settings: Awaited<ReturnType<typeof deps.laneConfig.calendarSettings>>): Promise<SelectedCalendar[]> {
    const entries: unknown[] = [];
    let pageToken: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_LIST_PAGES) throw bad("Calendar list has too many pages");
      const res = await deps.api.get(laneId, conn, PATH_CALENDAR_LIST, undefined, { maxResults: 250, fields: LIST_FIELDS, showDeleted: false, showHidden: false, ...(pageToken ? { pageToken } : {}) });
      const parsed = CalendarListPageSchema.safeParse(res.data);
      if (!parsed.success) throw bad("Calendar list is not valid");
      entries.push(...(parsed.data.items ?? []));
      pageToken = parsed.data.nextPageToken;
      if (pageToken === undefined) break;
      if (!isToken(pageToken)) throw bad("Calendar list page token is not valid");
    }
    const { calendars, dropped } = selectCalendars(entries, settings);
    if (dropped > 0) log.child({ laneId, provider: "google", connectionId: conn.id }).warn("google.calendar.calendars_skipped", { count: dropped });
    return calendars;
  }

  const resync = (): CalendarSyncResult => ({ upserts: [], removals: [], nextCursor: null, hasMore: false, fullResyncRequired: true });

  /**
   * Previous state + the calendars selected now: kept calendars keep their token, new ones start a full load, short
   * horizons reload. Returns the new state (position 0, discovery done) and the calendars that left the selection.
   */
  function merge(old: CursorState, selected: readonly SelectedCalendar[], today: number, backDays: number, forwardDays: number, fp: string): { state: CursorState; dropped: string[] } {
    const refreshBelow = Math.floor(forwardDays / 2);
    const cals: CalState[] = selected.map((s) => {
      const prev = old.cals.find((c) => c.id === s.id);
      const fresh: CalState = { id: s.id, t: null, pt: null, from: today - backDays, to: today + forwardDays };
      if (!prev || prev.t === null) return fresh;
      return prev.to - today < refreshBelow ? fresh : { ...prev, pt: null };
    });
    const dropped = old.cals.map((c) => c.id).filter((id) => !selected.some((s) => s.id === id));
    return { state: { i: 0, cals, d: true, s: fp }, dropped };
  }

  /** Errors that mean "this calendar, not the connection": the calendar is left out of the cursor and the run goes on. */
  function isPerCalendarFailure(e: unknown, resumed: boolean): boolean {
    if (!isConnectorError(e)) return false;
    const { kind, http_status: status } = e.info;
    if (kind === "not_found" && status === 404) return true;
    if (kind === "forbidden" && status === 403) return true; // a 403 that is not a rate limit (the API client maps those)
    if (!resumed && status === 400) return true; // an initial load Google refuses outright
    return false;
  }

  async function syncPage(laneId: LaneId, c: LaneBoundConnection<"google">, cursor: CommsCursor | null, pageSize: number): Promise<CalendarSyncResult> {
    // Fail closed before any request to Google: unreadable settings or policy end the sync.
    const settings = await deps.laneConfig.calendarSettings(laneId);
    const fp = selectionFingerprint(settings);
    let state: CursorState;
    if (cursor === null) {
      state = { i: 0, cals: [], d: false, s: fp };
    } else {
      const parsed = parseCalendarCursor(cursor.value, c.id);
      if (parsed === null) return resync();
      state = parsed;
    }
    const today = epochDay(now());
    let dropCalendars: string[] = [];
    // Discovery at the start of every run, and again whenever the lane's selection settings changed mid-run: a calendar
    // the lane no longer syncs gets no further request, and its rows are dropped with this page.
    if (!state.d || state.s !== fp) {
      const retention = await deps.laneConfig.retentionDays(laneId);
      const selected = await discover(laneId, c, settings);
      const merged = merge(state, selected, today, Math.min(EVENT_RETENTION_DAYS, retention), settings.forwardDays, fp);
      state = merged.state;
      dropCalendars = merged.dropped;
    }
    const finish = (r: Omit<CalendarSyncResult, "dropCalendars">): CalendarSyncResult =>
      CalendarSyncResultSchema.parse({ ...r, ...(dropCalendars.length > 0 ? { dropCalendars } : {}) });
    if (state.cals.length === 0) {
      return finish({ upserts: [], removals: [], nextCursor: encodeCalendarCursor(c.id, { i: 0, cals: [], d: false, s: fp }), hasMore: false, fullResyncRequired: false });
    }

    /** Leave the current calendar out of the cursor (permanent failure for it) and carry on with the next one. */
    const skipCurrent = (reason: string): CalendarSyncResult => {
      log.child({ laneId, provider: "google", connectionId: c.id }).warn("google.calendar.calendar_skipped", { reason });
      const cals = state.cals.filter((_, k) => k !== state.i);
      const finished = state.i >= cals.length;
      return finish({
        upserts: [],
        removals: [],
        nextCursor: encodeCalendarCursor(c.id, { i: finished ? 0 : state.i, cals, d: !finished, s: fp }),
        hasMore: !finished,
        fullResyncRequired: false,
      });
    };

    const cal = state.cals[state.i] as CalState;
    const raw = cal.id === PRIMARY_CALENDAR ? PRIMARY_CALENDAR : decodeCalendarId(cal.id);
    if (raw === null) return resync();
    const query = cal.t !== null
      ? { syncToken: cal.t, singleEvents: true, maxResults: pageSize, fields: EVENT_FIELDS, ...(cal.pt ? { pageToken: cal.pt } : {}) }
      : { singleEvents: true, showDeleted: true, timeMin: dayStartIso(cal.from), timeMax: dayStartIso(cal.to), maxResults: pageSize, fields: EVENT_FIELDS, ...(cal.pt ? { pageToken: cal.pt } : {}) };

    const resumed = cal.t !== null || cal.pt !== null;
    let data: unknown;
    try {
      data = (await deps.api.get(laneId, c, PATH_EVENTS, { calendarId: raw }, query)).data;
    } catch (e) {
      // Expired syncToken (410) or one Google refuses (400): reload everything. An initial load cannot be "expired"; the
      // sync run turns a resync during a full load into an error instead of looping.
      if (isConnectorError(e) && resumed && (e.info.http_status === 410 || e.info.http_status === 400)) return resync();
      if (isPerCalendarFailure(e, resumed)) return skipCurrent(`http_${String(isConnectorError(e) ? e.info.http_status : 0)}`);
      throw e; // rate_limited, transient, reconnect_required, connection_unavailable...
    }
    const page = EventsPageSchema.safeParse(data);
    if (!page.success) return skipCurrent("invalid_page");
    const calendarTz = validTimeZone(page.data.timeZone);

    const upserts: EventMeta[] = [];
    const skipped = new Map<string, number>();
    for (const item of page.data.items ?? []) {
      const out = toEventMeta(cal.id, calendarTz, item);
      if (out.kind === "event") upserts.push(out.meta);
      else skipped.set(out.reason, (skipped.get(out.reason) ?? 0) + 1);
    }
    if (skipped.size > 0) log.child({ laneId, provider: "google", connectionId: c.id }).warn("google.calendar.events_skipped", Object.fromEntries(skipped));

    const next = page.data.nextPageToken;
    let nextState: CursorState;
    let hasMore: boolean;
    if (next !== undefined) {
      if (!isToken(next)) return skipCurrent("unexpected_page_token");
      nextState = { ...state, cals: state.cals.map((x, k) => (k === state.i ? { ...x, pt: next } : x)) };
      hasMore = true;
    } else {
      const token = page.data.nextSyncToken;
      if (token === undefined || !isToken(token)) return skipCurrent("unexpected_sync_token");
      const cals = state.cals.map((x, k) => (k === state.i ? { ...x, t: token, pt: null } : x));
      const i = state.i + 1;
      hasMore = i < cals.length;
      nextState = { i: hasMore ? i : 0, cals, d: hasMore, s: fp };
    }
    return finish({ upserts, removals: [], nextCursor: encodeCalendarCursor(c.id, nextState), hasMore, fullResyncRequired: false });
  }

  const polling = (): WatchInfo => ({ mode: "polling", resource: "calendar", channel_id: null, resource_id: null, expires_at: null, created_at: new Date(now()).toISOString() });

  const provider: CalendarProvider<"google"> = {
    provider: "google",
    capabilities,

    async sync(laneId, conn, cursor, options) {
      const c = await guard(laneId, conn, { mailbox: true });
      const opts = CommsSyncOptionsSchema.safeParse(options ?? {});
      if (!opts.success) throw invalid("Invalid sync options");
      if (cursor !== null && !CommsCursorSchema.safeParse(cursor).success) throw invalid("Invalid cursor");
      return syncPage(laneId, c, cursor, opts.data.pageSize ?? DEFAULT_PAGE_SIZE);
    },

    async readBody(laneId, conn, calendarId, eventId, options) {
      const c = await guard(laneId, conn, { mailbox: true });
      if (!ProviderIdParamSchema.safeParse(calendarId).success || !ProviderIdParamSchema.safeParse(eventId).success) throw invalid("Invalid calendar or event id");
      const raw = calendarId === PRIMARY_CALENDAR ? PRIMARY_CALENDAR : decodeCalendarId(calendarId);
      if (raw === null) throw invalid("Invalid calendar id");
      const opts = ReadBodyOptionsSchema.safeParse(options ?? {});
      if (!opts.success) throw invalid("Invalid read options");
      // Only calendars the lane syncs can be opened (a shared or subscribed calendar outside the selection is not read).
      const settings = await deps.laneConfig.calendarSettings(laneId);
      const selected = await discover(laneId, c, settings);
      if (!selected.some((s) => s.id === calendarId)) throw new ConnectorError({ kind: "forbidden", message: "This calendar is not one of the lane's synced calendars" });
      const res = await deps.api.get(laneId, c, PATH_EVENT, { calendarId: raw, eventId }, { fields: "id,description" });
      const parsed = DescriptionSchema.safeParse(res.data);
      if (!parsed.success) throw bad("Calendar event is not valid");
      const max = opts.data.maxChars ?? DEFAULT_MAX_BODY_CHARS;
      // The description may be HTML (Google lets people paste it); the text is cut BEFORE conversion at a bounded size.
      const source = parsed.data.description ?? "";
      const plain = htmlToText(source.slice(0, Math.min(max * 4, 1_000_000))).replace(/\u0000/g, "");
      const { text, truncated } = cut(plain, max);
      return envelope(laneId, c, "calendar.read_body", new UntrustedBody({ origin: "calendar", text, contentType: "text/plain", truncated: truncated || source.length > max * 4 }));
    },

    // Calendar push (events.watch) is not built: polling, no channel and no request.
    async watch(laneId, conn): Promise<WatchInfo[]> {
      await guard(laneId, conn);
      return [polling()];
    },
    async renew(laneId, conn): Promise<WatchInfo> {
      await guard(laneId, conn);
      return polling();
    },
    async stop(laneId, conn): Promise<void> {
      await guard(laneId, conn);
    },

    async prepareWrite(laneId, conn, intent): Promise<ProposedPayload<"google">> {
      await guard(laneId, conn);
      if (!CalendarWriteIntentSchema.safeParse(intent).success) throw invalid("Invalid calendar write intent");
      throw new ConnectorError({ kind: "unsupported_op", message: "Calendar writes are not available until phase 4" });
    },
  };
  return provider;
}
