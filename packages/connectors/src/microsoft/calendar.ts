// Microsoft Graph CalendarProvider (T-067, spec §9, decision D-59): event metadata sync of the person's DEFAULT calendar, live event body, polling watch.
// Read-only against Graph by construction (the Graph client has GET only); `prepareWrite` answers `unsupported_op` AFTER the guard (calendar writes are phase 4).
//
// D-59 (Nov 21, 2026, Saurabh): Microsoft's v1.0 documentation describes calendar change tracking only for the default calendar, so a connection syncs
// that one calendar and nothing else: ONE request path, `GET /me/calendarView/delta`. There is no `GET /me/calendars`, no per-calendar request and no
// calendar selection. `microsoft.calendar_ids` (lane config) is IGNORED and logged once per run as a COUNT, never an error and never the ids;
// `calendar.calendar_ids` and `calendar.include_read_only` are not applied to a Microsoft connection (they describe Google calendars). Every row carries
// the one fixed calendar id `microsoft:default` (./cal-cursor.ts).
//
// Window and cursor: the window (`startDateTime`, `endDateTime`) goes on the INITIAL request only, as `[today - min(180, retention), today + forward_days]` in UTC
// ISO 8601; every later request is the returned link, its validated query sent back unchanged (./cal-cursor.ts holds the link rules). `$select`, `$filter`,
// `$orderby`, `$search` and `$expand` are not supported on this delta and are never sent, so Graph returns event BODIES on every page: the mapper drops them in
// memory (./cal-map.ts, rule 6). Every request, including one made from a stored link, carries ONE `Prefer` header:
// `IdType="ImmutableId", outlook.timezone="UTC", odata.maxpagesize=N` (a preference applies only to the request it is on). When the forward part of the window
// has run down below half of `forward_days`, a fresh full load with a new window starts (as T-064 does for Google); the old link is kept until it completes.
//
// Failure rules (as T-258/T-259): 410, or a 4xx with the code `syncStateNotFound` / `resyncRequired`, on a STORED link -> `fullResyncRequired` (an answer). A
// foreign, mail-prefixed, other-connection, malformed or oversized cursor, or a stored link that fails validation -> `fullResyncRequired` with no request. A link
// Graph returns that fails validation is not stored: a fixed-message `provider_error`; a nextLink equal to the one just used is an error; a link longer than the bound is
// never cut (a resync). Any other failure throws and never advances the cursor. A refusal of ours (reconnect required, provider disabled, a guard failure) fails the page.
// One malformed item is skipped and counted, never failing the page. `@removed` -> a removal, whatever the reason (Microsoft also sends one for an event that left the
// date range; the page writer marks the row cancelled, which is right for an event that is no longer in the window).
//
// readBody: `GET /me/events/{id}?$select=body`, text preferred, type read from the answer, HTML converted, bounded, `UntrustedBody`, freshness `live`, never persisted.
// The calendar id must be `microsoft:default`; whether the event itself lives in the default calendar cannot be asked of Graph on this path (see readBody).
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
  type EventMeta,
  type EventRemoval,
  type WatchInfo,
} from "../comms/schemas";
import { ConnectorError } from "../contract/errors";
import type { SourceResult } from "../contract/schemas";
import { PROVIDER_DISABLED_MESSAGE, providerEnabledIn } from "../facade/gate";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { LaneConfigReader } from "../vault/lane-config";
import type { GraphApi } from "./api";
import { CAL_DELTA_PATH, DEFAULT_CALENDAR_ID, encodeCalCursor, initialQuery, MAX_BACK_DAYS, MAX_CURSOR_CHARS, MAX_LINK_CHARS, newWindow, parseCalCursor, reloadDue, validateCalendarLink, type CalState, type CalWindow } from "./cal-cursor";
import { mapEvent, removalOf } from "./cal-map";
import type { MicrosoftGuard } from "./guard";
import { bodyFromAnswer } from "./mail-live";
import { isExpiredDeltaState } from "./mail";

export type MicrosoftCalendarDeps = {
  /** The guarded, read-only Graph client (it runs the guard again before every request attempt). */
  api: Pick<GraphApi, "get">;
  guard: MicrosoftGuard;
  /** `mailProviderSettings` (the enabled check and the ignored `microsoft.calendar_ids`), `calendarSettings` (`forward_days`; unreadable fails closed) and `retentionDays` (fails closed). */
  laneConfig: Pick<LaneConfigReader, "mailProviderSettings" | "calendarSettings" | "retentionDays">;
  now?: () => number;
  logger?: ConnectorLogger;
  /** Default body length of `readBody` when the caller names none. */
  defaultMaxBodyChars?: number;
};

const PATH_EVENT = "/me/events/{id}";
/**
 * Events are bigger than mail metadata (the delta cannot `$select`, so each carries its body), so a page asks for fewer items than the mail sync's 100.
 * `CommsSyncOptions.pageSize` overrides it.
 */
const DEFAULT_PAGE_SIZE = 50;
/** More items than this in one page is not a page (a provider bug or an attack). */
const MAX_PAGE_ITEMS = 2000;
/** Same default as the Gmail reader and the Microsoft mail reader. */
export const DEFAULT_CALENDAR_BODY_CHARS = 200_000;
const BODY_PREFER = { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' };

const PageSchema = z.object({
  value: z.array(z.unknown()).max(MAX_PAGE_ITEMS),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});

const invalid = (message: string) => new ConnectorError({ kind: "invalid_input", message });
const providerError = (message: string) => new ConnectorError({ kind: "provider_error", message });

/** The three preferences in ONE header value, on every request (a preference applies only to the request it is on). */
export const calendarPrefer = (pageSize: number): { Prefer: string } => ({ Prefer: `IdType="ImmutableId", outlook.timezone="UTC", odata.maxpagesize=${String(pageSize)}` });

export function createMicrosoftCalendarProvider(deps: MicrosoftCalendarDeps): CalendarProvider<"microsoft"> {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? connectorLog;
  const capabilities: CalendarCapabilities = { watch: "polling", prepareWrite: false };
  const defaultMaxChars = deps.defaultMaxBodyChars ?? DEFAULT_CALENDAR_BODY_CHARS;
  type GuardedConn = Awaited<ReturnType<MicrosoftGuard>>["conn"];

  const envelope = <T>(laneId: LaneId, c: GuardedConn, op: string, data: T): SourceResult<T, "microsoft"> => {
    const at = new Date(now()).toISOString();
    return { lane_id: laneId, provider: "microsoft", connection_id: c.id, op, data, as_of: at, fetched_at: at, freshness: "live", provider_tid: null, source_refs: [], notes: [] };
  };
  const done = (r: CalendarSyncResult): CalendarSyncResult => CalendarSyncResultSchema.parse(r);
  const resync = (): CalendarSyncResult => ({ upserts: [], removals: [], nextCursor: null, hasMore: false, fullResyncRequired: true });
  const pollingWatch = (): WatchInfo => ({ mode: "polling", resource: "calendar", channel_id: null, resource_id: null, expires_at: null, created_at: new Date(now()).toISOString() });
  const notSupportedCloud = () => new ConnectorError({ kind: "unsupported_op", message: "This Microsoft cloud is not supported yet" });

  async function syncPage(laneId: LaneId, conn: Parameters<MicrosoftGuard>[1], cursor: Parameters<CalendarProvider<"microsoft">["sync"]>[2], options: Parameters<CalendarProvider<"microsoft">["sync"]>[3]): Promise<CalendarSyncResult> {
    const g = await deps.guard(laneId, conn); // lane, provider, status, tenant, cloud, mail policy: before anything is read or requested
    const c = g.conn;
    const opts = CommsSyncOptionsSchema.safeParse(options ?? {});
    if (!opts.success) throw invalid("Invalid sync options");
    // A value longer than the cursor table holds cannot be one of ours: it is answered like any foreign cursor (a resync), not as a caller error.
    const oversized = cursor !== null && typeof cursor.value === "string" && cursor.value.length > MAX_CURSOR_CHARS;
    if (cursor !== null && !oversized && !CommsCursorSchema.safeParse(cursor).success) throw invalid("Invalid cursor");
    const pageSize = opts.data.pageSize ?? DEFAULT_PAGE_SIZE;

    // One settings read for the enabled check and the ignored calendar list; an unreadable calendar setting fails the sync closed before any request.
    const settings = await deps.laneConfig.mailProviderSettings(laneId);
    if (!providerEnabledIn(settings, "microsoft") || !settings.microsoft) throw new ConnectorError({ kind: "connection_unavailable", message: PROVIDER_DISABLED_MESSAGE });
    if (g.cloud !== "commercial") throw notSupportedCloud();
    const calendarSettings = await deps.laneConfig.calendarSettings(laneId);
    const nowMs = now();

    let state: CalState | null = null;
    if (cursor !== null) {
      state = oversized ? null : parseCalCursor(cursor.value, c.id);
      if (state === null) return resync(); // foreign, mail-prefixed, other connection, malformed, oversized, or a link that fails validation: no request is made
    }
    // A run starts without a cursor or from a finished delta link; a page in progress continues from a nextLink.
    if ((state === null || state.k === "d") && settings.microsoft.calendarIds !== null) {
      // D-59: the list is not applied to a Microsoft connection. A count only, never the ids.
      log.child({ laneId, provider: "microsoft", connectionId: c.id }).info("microsoft.calendar.calendar_ids_ignored", { count: settings.microsoft.calendarIds.length });
    }

    // Which request: the initial one (a new window, only the window in the query) or the stored link (its validated query, unchanged).
    let window: CalWindow;
    let stored: string | undefined;
    let rawQuery: string;
    if (state === null || (state.k === "d" && reloadDue(state.w, nowMs, calendarSettings.forwardDays))) {
      const retention = await deps.laneConfig.retentionDays(laneId); // an unreadable policy fails the sync (closed)
      window = newWindow(nowMs, Math.min(MAX_BACK_DAYS, retention), calendarSettings.forwardDays);
      stored = undefined;
      rawQuery = initialQuery(window);
      if (state !== null) log.child({ laneId, provider: "microsoft", connectionId: c.id }).info("microsoft.calendar.window_reload", {});
    } else {
      window = state.w;
      stored = state.l;
      const checked = validateCalendarLink(stored, window);
      if (checked === null) return resync();
      rawQuery = checked.query;
    }

    let data: unknown;
    try {
      data = (await deps.api.get(laneId, c, CAL_DELTA_PATH, undefined, undefined, { headers: calendarPrefer(pageSize), rawQuery })).data;
    } catch (e) {
      // Only a STORED link can be expired; the first request of a load is never answered with a resync (it would loop).
      if (stored !== undefined && isExpiredDeltaState(e)) {
        log.child({ laneId, provider: "microsoft", connectionId: c.id }).warn("microsoft.calendar.delta_state_expired", {});
        return resync();
      }
      throw e;
    }
    const page = PageSchema.safeParse(data);
    if (!page.success) throw providerError("Microsoft calendar delta is not valid");
    const next = page.data["@odata.nextLink"];
    const delta = page.data["@odata.deltaLink"];
    if ((next === undefined) === (delta === undefined)) throw providerError("Microsoft calendar delta is not valid"); // exactly one of the two ends a page

    // The last entry for an id wins (the page writer applies removals first, so an id must not appear in both lists).
    const upserts = new Map<string, EventMeta>();
    const removals = new Map<string, EventRemoval>();
    const skipped: Record<string, number> = {};
    const skip = (reason: string) => void (skipped[reason] = (skipped[reason] ?? 0) + 1);
    for (const item of page.data.value) {
      if (typeof item === "object" && item !== null && "@removed" in item) {
        // Any `@removed` (a delete, or an event that left the date range) removes the row of this connection.
        const r = removalOf(item);
        if (r === null) skip("invalid_removal");
        else {
          upserts.delete(r.event_id);
          removals.set(r.event_id, r);
        }
        continue;
      }
      const out = mapEvent(item, { cloud: g.cloud });
      if (out.kind === "event") {
        removals.delete(out.meta.event_id);
        upserts.set(out.meta.event_id, out.meta);
      } else skip(out.reason);
    }
    if (Object.keys(skipped).length > 0) log.child({ laneId, provider: "microsoft", connectionId: c.id }).warn("microsoft.calendar.events_skipped", skipped);

    // A nextLink equal to the link just used would page the same data forever, run after run: refuse it.
    if (next !== undefined && next === stored) throw providerError("Microsoft returned the same page link again");
    const link = (next ?? delta) as string;
    if (link.length > MAX_LINK_CHARS) return resync(); // too long for the cursor: fail safe, never truncated
    if (validateCalendarLink(link, window) === null) throw providerError("Microsoft returned a link that cannot be used");
    const nextCursor = encodeCalCursor(c.id, { v: 1, w: window, k: next !== undefined ? "n" : "d", l: link });
    if (nextCursor === null) return resync(); // the state would not fit the table's limit: fail safe

    return done({ upserts: [...upserts.values()], removals: [...removals.values()], nextCursor, hasMore: next !== undefined, fullResyncRequired: false });
  }

  const provider: CalendarProvider<"microsoft"> = {
    provider: "microsoft",
    capabilities,

    sync: (laneId, conn, cursor, options) => syncPage(laneId, conn, cursor, options),

    async readBody(laneId, conn, calendarId, eventId, options) {
      const g = await deps.guard(laneId, conn); // before the ids are looked at and before any token read
      const cal = ProviderIdParamSchema.safeParse(calendarId);
      const id = ProviderIdParamSchema.safeParse(eventId);
      if (!cal.success || !id.success) throw invalid("Invalid calendar or event id"); // fixed text: the ids are never echoed; checked before any request
      const opts = ReadBodyOptionsSchema.safeParse(options ?? {});
      if (!opts.success) throw invalid("Invalid read options");
      // D-59: only the default calendar is synced, so only its events are listed in the index and only that calendar id exists.
      if (cal.data !== DEFAULT_CALENDAR_ID) throw new ConnectorError({ kind: "forbidden", message: "Only events of the default calendar can be opened" });
      if (g.cloud !== "commercial") throw notSupportedCloud();
      // `/me/events/{id}` answers for the event id alone: Graph is not asked which calendar holds it, and this provider has no access to the index to
      // check that the id is one of its rows. The id comes from an index row (the default calendar only) in every caller; the owner check of the facade
      // and the provider guard still apply. Not enforceable here, stated in the T-067 PR body.
      const res = await deps.api.get(laneId, g.conn, PATH_EVENT, { id: id.data }, undefined, { headers: BODY_PREFER, rawQuery: "$select=body" });
      const body = bodyFromAnswer(res.data, opts.data.maxChars ?? defaultMaxChars);
      if (body === null) throw providerError("Microsoft event body is not valid"); // never the content
      return envelope(laneId, g.conn, "calendar.read_body", new UntrustedBody({ origin: "calendar", text: body.text, contentType: "text/plain", truncated: body.truncated }));
    },

    // Graph change notifications are T-068 / T-264: until then the calendar is polled, no subscription is created.
    async watch(laneId, conn): Promise<WatchInfo[]> {
      await deps.guard(laneId, conn);
      return [pollingWatch()];
    },
    async renew(laneId, conn): Promise<WatchInfo> {
      await deps.guard(laneId, conn);
      return pollingWatch();
    },
    async stop(laneId, conn): Promise<void> {
      await deps.guard(laneId, conn);
    },

    async prepareWrite(laneId, conn, intent) {
      await deps.guard(laneId, conn);
      if (!CalendarWriteIntentSchema.safeParse(intent).success) throw invalid("Invalid calendar write intent");
      throw new ConnectorError({ kind: "unsupported_op", message: "Calendar writes are not available until phase 4" });
    },
  };
  return provider;
}
