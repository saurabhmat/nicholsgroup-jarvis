// The Microsoft calendar sync wired over in-memory twins (T-067 tests only), attached to a Microsoft mail harness (./microsoft-mail-harness.ts) so one lane
// has BOTH streams: the REAL guard, token manager, Graph client and calendar provider and runner, the fake Graph calendar (./msw/microsoft/calendar.ts) and the
// calendar index twin (./cal-index-twin.ts), beside the mail provider, runner and index twin of the same connection. `persistedContentWrites` is a real count:
// every write into the calendar index twin, every log line and every recorded API error is scanned for the content canaries the fake serves (the event body,
// the preview, a deprecated field).
import { createCalendarSync } from "../comms/cal-sync";
import { ConnectorError } from "../contract/errors";
import { createMicrosoftCalendarProvider } from "../microsoft/calendar";
import { DEFAULT_CALENDAR_ID } from "../microsoft/cal-cursor";
import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings } from "../vault/lane-config";
import type { EventMeta } from "../comms/schemas";
import { createCalendarIndexTwin } from "./cal-index-twin";
import type { CommsContractHarness, CommsFaultKind } from "./comms-contract";
import type { MicrosoftMailHarness } from "./microsoft-mail-harness";
import { CAL_BODY_CANARY, CAL_PREVIEW_CANARY, CAL_SERIES_CANARY, type FakeCalendar } from "./msw/microsoft/calendar";
import { FAKE_NOW } from "./msw/microsoft/mail";

export const CAL_CANARIES = [CAL_BODY_CANARY, CAL_PREVIEW_CANARY, CAL_SERIES_CANARY] as const;
const contractEventId = "AAMkSyntheticContractEvent=";

export type MicrosoftCalendarOptions = {
  /** `lane_config.calendar` per lane (default: the defaults, 365 days ahead); "unreadable" makes the read fail (fail-closed tests). */
  calendar?: Record<string, CalendarSettings | "unreadable">;
  /** The provider's clock (the window, the half-horizon rule). Default: the fake's fixed now. */
  providerNow?: () => number;
  /** Run time budget and clock of the sync runner. */
  maxRunMs?: number;
  runnerNow?: () => number;
  pageSize?: number;
  maxPages?: number;
  defaultMaxBodyChars?: number;
};

export function attachMicrosoftCalendar(m: MicrosoftMailHarness, cal: FakeCalendar, options: MicrosoftCalendarOptions = {}) {
  const { h, fake } = m;
  const calendarConfig: Record<string, CalendarSettings | "unreadable"> = { ...options.calendar };
  const settingsReads = { count: 0 };
  const laneConfig = {
    mailProviderSettings: h.laneConfig.mailProviderSettings,
    retentionDays: m.laneConfig.retentionDays,
    async calendarSettings(laneId: string): Promise<CalendarSettings> {
      settingsReads.count += 1;
      const c = calendarConfig[laneId];
      if (c === "unreadable") throw new ConnectorError({ kind: "provider_error", message: "The lane's calendar settings are not valid" });
      return c ? { ...c } : { ...DEFAULT_CALENDAR_SETTINGS };
    },
  };
  const provider = createMicrosoftCalendarProvider({ api: m.api, guard: h.guard, laneConfig, now: options.providerNow ?? (() => FAKE_NOW), logger: m.logger, ...(options.defaultMaxBodyChars !== undefined ? { defaultMaxBodyChars: options.defaultMaxBodyChars } : {}) });
  const twin = createCalendarIndexTwin({
    rowOf: (laneId, conn) => {
      const row = h.rows.get(conn.id);
      if (!row || row.lane_id !== laneId) throw new Error("unknown connection");
      return row;
    },
  });
  const sync = createCalendarSync({ calendar: provider, store: twin.store, logger: m.logger, ...(options.maxRunMs !== undefined ? { maxRunMs: options.maxRunMs } : {}), ...(options.runnerNow ? { now: options.runnerNow } : {}), ...(options.pageSize ? { pageSize: options.pageSize } : {}), ...(options.maxPages ? { maxPages: options.maxPages } : {}) });

  const mentionsCanary = (v: unknown) => {
    const text = typeof v === "string" ? v : JSON.stringify(v);
    return CAL_CANARIES.some((c) => text.includes(c));
  };
  const contentWriteCount = (): number => twin.writes.filter((w) => mentionsCanary(w.value)).length + h.logs.filter((l) => mentionsCanary(l)).length + h.apiErrors.filter((e) => mentionsCanary(e)).length;
  const externalRequestCount = (): number => fake.state.tokenRequests.length + fake.state.graphRequests.length + m.mail.requests.length + cal.requests.length;

  /** A Google connection of the lane with a calendar row and a calendar cursor of its own (and the mail row and cursor `seedGoogle` already makes). */
  function seedGoogleCalendar(laneId: string, opts: { ownerId?: string } = {}) {
    const google = m.seedGoogle(laneId, opts.ownerId ? { ownerId: opts.ownerId } : {});
    const at = new Date(FAKE_NOW - 86_400_000).toISOString();
    const event: EventMeta = {
      calendar_id: "primary", event_id: "google-event-1", ical_uid: null, source_url: null, title: "Synthetic Google meeting", location: null, organizer_email: null, organizer_name: null,
      start_at: new Date(FAKE_NOW + 3_600_000).toISOString(), end_at: new Date(FAKE_NOW + 7_200_000).toISOString(), all_day: false, start_date: null, end_date: null, timezone: "America/New_York", attendees: [],
      status: "confirmed", recurring_event_id: null, original_start_at: null, online_meeting_url: null, source_updated_at: at,
    };
    const cursor = `g1.${google.row.id}.c:AAAA`;
    twin.seed(laneId, google.row.id, [event], cursor);
    return { ...google, event, calendarCursor: cursor };
  }

  function contractHarness(): CommsContractHarness {
    const accountOf = m.accountOf;
    return {
      calendar: provider as never,
      laneId: "PKG",
      otherLaneId: "APK",
      async connect(opts = {}) {
        const made = m.connect(opts.laneId ?? "PKG", opts.mailbox ? { address: opts.mailbox } : {});
        cal.events(accountOf(made.conn)); // the seed exists, the same size for every connection
        // The event the contract reads the body of.
        cal.add(accountOf(made.conn), { id: contractEventId, subject: "Synthetic contract event", startInDays: 2 });
        return made.conn as never;
      },
      async connectForeignProvider() {
        return m.seedGoogle("PKG").conn as never;
      },
      markReconnectRequired(conn) {
        const row = h.rows.get(conn.id);
        if (row) row.status = "reconnect_required";
      },
      injectFault(conn, kind: CommsFaultKind) {
        cal.setFault(accountOf(conn), kind);
      },
      addMessage: () => {
        throw new Error("mail is not under test here (see the mail contract)");
      },
      removeMessage: () => {
        throw new Error("mail is not under test here (see the mail contract)");
      },
      addEvent: (conn) => cal.add(accountOf(conn), { subject: "Synthetic added event" }),
      removeEvent: (conn) => cal.remove(accountOf(conn), cal.bySubject(accountOf(conn), "Synthetic single 2").id),
      cancelEvent: (conn) => cal.cancel(accountOf(conn), cal.bySubject(accountOf(conn), "Synthetic single 1").id),
      removedEventsAreStubs: false,
      externalWriteCount: () => cal.requests.filter((r) => r.method !== "GET").length + m.mail.requests.filter((r) => r.method !== "GET").length + fake.state.graphRequests.filter((r) => r.method !== "GET").length,
      externalRequestCount,
      tokenReads: () => h.stats.tokenReads,
      persistedContentWrites: contentWriteCount,
      bodyCanary: CAL_BODY_CANARY,
      fixtures: { messageId: "", messageSearchTerm: "", calendarId: DEFAULT_CALENDAR_ID, calendarIds: [DEFAULT_CALENDAR_ID], eventId: contractEventId, documentId: "", documentSearchTerm: "" },
    };
  }

  return { m, cal, provider, sync, twin, laneConfig, calendarConfig, settingsReads, contentWriteCount, externalRequestCount, seedGoogleCalendar, contractHarness };
}
export type MicrosoftCalendarHarness = ReturnType<typeof attachMicrosoftCalendar>;
