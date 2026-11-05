// Calendar id encoding, calendar selection, event mapping and the composite cursor (T-064). Pure functions; synthetic data.
import { describe, expect, it } from "vitest";
import { EventMetaSchema, ProviderIdParamSchema } from "../comms/schemas";
import {
  decodeCalendarId,
  encodeCalendarCursor,
  encodeCalendarId,
  parseCalendarCursor,
  PRIMARY_CALENDAR,
  selectCalendars,
  toEventMeta,
  type CursorState,
} from "./calendar-events";

const CONN = "00000000-0000-4000-8000-000000000641";
const meta = (r: ReturnType<typeof toEventMeta>) => {
  if (r.kind !== "event") throw new Error(`skipped: ${r.reason}`);
  return r.meta;
};

describe("calendar id encoding", () => {
  it("encodes '#' and '=' reversibly and always satisfies the id-parameter rule", () => {
    for (const raw of ["en.usa#holiday@group.v.calendar.google.com", "addressbook#contacts@group.v.calendar.google.com", "a=b#c", "plain@example.test", "c_abc123@group.calendar.google.com", "ünï cødé/x?y%z"]) {
      const enc = encodeCalendarId(raw);
      expect(enc, raw).not.toBeNull();
      expect(ProviderIdParamSchema.safeParse(enc).success, raw).toBe(true);
      expect(decodeCalendarId(enc as string), raw).toBe(raw);
    }
    expect(encodeCalendarId("en.usa#holiday@group.v.calendar.google.com")).toBe("en.usa=23holiday@group.v.calendar.google.com");
    expect(encodeCalendarId("a=b")).toBe("a=3Db");
    expect(encodeCalendarId("plain@example.test")).toBe("plain@example.test");
  });

  it("refuses ids that cannot be stored: empty, control characters, dot segments, too long", () => {
    expect(encodeCalendarId("")).toBeNull();
    expect(encodeCalendarId("a\nb")).toBeNull();
    expect(encodeCalendarId("..")).toBeNull();
    expect(encodeCalendarId(".")).toBeNull();
    expect(encodeCalendarId("a".repeat(201))).toBeNull();
    expect(encodeCalendarId("#".repeat(70))).toBeNull(); // 70 * 3 > 200
  });

  it("decoding rejects anything that is not a well-formed encoded id", () => {
    for (const bad of ["", "a#b", "a/b", "a=2", "a=zz", "a=23=", "x=C3", "=41", "a%23b", "a b", "=00", "..", "a".repeat(601), "=0A"]) {
      expect(decodeCalendarId(bad), bad).toBeNull();
    }
  });

  it("decoding is a bijection: only the canonical spelling decodes (no lower-case hex, no escaped safe characters)", () => {
    expect(decodeCalendarId("a=23b")).toBe("a#b");
    expect(decodeCalendarId("a=2Fb")).toBe("a/b"); // canonical spelling of '/'
    expect(decodeCalendarId("a=2fb")).toBeNull(); // lower-case hex
    expect(decodeCalendarId("a=41b")).toBeNull(); // 'A' needs no escape: a second spelling of "aAb"
    expect(decodeCalendarId("a=40b")).toBeNull(); // '@' is safe
    expect(decodeCalendarId("=C3=BC")).toBe("\u00fc");
    expect(decodeCalendarId("=C3=bc")).toBeNull();
  });

  it("is linear on hostile input", () => {
    const t = Date.now();
    decodeCalendarId("=".repeat(100_000));
    decodeCalendarId("a".repeat(1_000_000));
    encodeCalendarId("#".repeat(1_000_000));
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe("calendar selection", () => {
  const entries = [
    { id: "me@example.test", primary: true, accessRole: "owner", selected: true },
    { id: "c_owned@group.calendar.google.com", accessRole: "owner", selected: true },
    { id: "c_writer@group.calendar.google.com", accessRole: "writer", selected: true },
    { id: "c_hidden@group.calendar.google.com", accessRole: "owner" },
    { id: "c_reader@group.calendar.google.com", accessRole: "reader", selected: true },
    { id: "en.usa#holiday@group.v.calendar.google.com", accessRole: "reader", selected: true },
    { id: "c_busy@group.calendar.google.com", accessRole: "freeBusyReader", selected: true },
    { id: "c_deleted@group.calendar.google.com", accessRole: "owner", selected: true, deleted: true },
    { id: "c_odd@group.calendar.google.com", accessRole: "banana", selected: true },
    "not an object",
  ];

  it("default: primary plus selected owner/writer calendars; read-only, hidden, deleted and free/busy are left out", () => {
    const { calendars } = selectCalendars(entries, { calendarIds: null, includeReadOnly: false });
    expect(calendars.map((c) => c.id)).toEqual([PRIMARY_CALENDAR, "c_owned@group.calendar.google.com", "c_writer@group.calendar.google.com"]);
    expect(calendars[0]?.raw).toBe("primary");
  });

  it("includeReadOnly adds selected readers, with '#' encoded; free/busy-only calendars stay out", () => {
    const { calendars } = selectCalendars(entries, { calendarIds: null, includeReadOnly: true });
    const ids = calendars.map((c) => c.id);
    expect(ids).toContain("en.usa=23holiday@group.v.calendar.google.com");
    expect(ids).toContain("c_reader@group.calendar.google.com");
    expect(ids).not.toContain("c_busy@group.calendar.google.com");
    expect(calendars.find((c) => c.id.startsWith("en.usa"))?.raw).toBe("en.usa#holiday@group.v.calendar.google.com");
  });

  it("an explicit list replaces the default, regardless of selected/role (but never a calendar not in Google's list)", () => {
    const { calendars } = selectCalendars(entries, { calendarIds: ["c_hidden@group.calendar.google.com", "en.usa#holiday@group.v.calendar.google.com", "c_unknown@group.calendar.google.com"], includeReadOnly: false });
    expect(calendars.map((c) => c.id).sort()).toEqual(["c_hidden@group.calendar.google.com", "en.usa=23holiday@group.v.calendar.google.com"]);
    expect(selectCalendars(entries, { calendarIds: ["primary"], includeReadOnly: false }).calendars.map((c) => c.id)).toEqual([PRIMARY_CALENDAR]);
  });

  it("caps the list at 10 calendars (the composite cursor must stay small) and drops ids that cannot be stored", () => {
    const many = Array.from({ length: 14 }, (_v, i) => ({ id: `c_${String(i).padStart(2, "0")}@group.calendar.google.com`, accessRole: "owner", selected: true }));
    const r = selectCalendars([{ id: "me@example.test", primary: true, accessRole: "owner" }, ...many, { id: "x".repeat(300), accessRole: "owner", selected: true }], { calendarIds: null, includeReadOnly: false });
    expect(r.calendars).toHaveLength(10);
    expect(r.calendars[0]?.id).toBe(PRIMARY_CALENDAR);
    expect(r.dropped).toBeGreaterThanOrEqual(5);
  });
});

describe("event mapping", () => {
  const timed = (over: Record<string, unknown> = {}) => ({
    id: "e1",
    status: "confirmed",
    updated: "2026-10-01T10:00:00.000Z",
    summary: "Board call",
    location: "Room 4",
    htmlLink: "https://www.google.com/calendar/event?eid=abc",
    iCalUID: "e1@google.com",
    organizer: { email: "Boss@Example.Test", displayName: "Boss" },
    start: { dateTime: "2026-10-21T14:00:00-04:00" },
    end: { dateTime: "2026-10-21T15:00:00-04:00" },
    attendees: [{ email: "A@Example.Test", displayName: "Alice", responseStatus: "needsAction" }],
    ...over,
  });

  it("maps a timed event: instants in UTC, organizer and attendees lower-cased, link and version kept", () => {
    const e = meta(toEventMeta("primary", "America/New_York", timed()));
    expect(e).toMatchObject({
      calendar_id: "primary",
      event_id: "e1",
      title: "Board call",
      location: "Room 4",
      organizer_email: "boss@example.test",
      start_at: "2026-10-21T18:00:00.000Z",
      end_at: "2026-10-21T19:00:00.000Z",
      all_day: false,
      start_date: null,
      timezone: "America/New_York",
      status: "confirmed",
      source_updated_at: "2026-10-01T10:00:00.000Z",
      source_url: "https://www.google.com/calendar/event?eid=abc",
    });
    expect(e.attendees).toEqual([{ email: "a@example.test", name: "Alice", response: "needs_action" }]);
  });

  it("a wall-clock time without an offset is resolved in the event's zone (DST-correct)", () => {
    const summer = meta(toEventMeta("primary", "America/New_York", timed({ start: { dateTime: "2026-10-23T09:00:00", timeZone: "America/New_York" }, end: { dateTime: "2026-10-23T09:30:00", timeZone: "America/New_York" } })));
    expect(summer.start_at).toBe("2026-10-23T13:00:00.000Z"); // EDT
    const winter = meta(toEventMeta("primary", "America/New_York", timed({ start: { dateTime: "2026-11-03T09:00:00" }, end: { dateTime: "2026-11-03T09:30:00" } })));
    expect(winter.start_at).toBe("2026-11-03T14:00:00.000Z"); // EST, from the calendar zone
    expect(toEventMeta("primary", null, timed({ start: { dateTime: "2026-11-03T09:00:00" }, end: { dateTime: "2026-11-03T09:30:00" } })).kind).toBe("skip");
  });

  it("all-day: dates kept (end exclusive), instants are local midnights of the CALENDAR zone, across a DST change", () => {
    const dst = meta(toEventMeta("primary", "America/New_York", { id: "d", status: "confirmed", summary: "x", start: { date: "2026-11-01" }, end: { date: "2026-11-03" } }));
    expect(dst).toMatchObject({ all_day: true, start_date: "2026-11-01", end_date: "2026-11-03", start_at: "2026-11-01T04:00:00.000Z", end_at: "2026-11-03T05:00:00.000Z", timezone: "America/New_York" });
    const london = meta(toEventMeta("c", "Europe/London", { id: "l", start: { date: "2026-10-25" }, end: { date: "2026-10-26" } }));
    expect(london).toMatchObject({ start_at: "2026-10-24T23:00:00.000Z", end_at: "2026-10-26T00:00:00.000Z" });
    expect(EventMetaSchema.safeParse(london).success).toBe(true);
  });

  it("an all-day event with no zone, a bad date or an end that is not after the start is skipped, never guessed", () => {
    expect(toEventMeta("c", null, { id: "d", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } })).toEqual({ kind: "skip", reason: "all_day_without_timezone" });
    expect(toEventMeta("c", "UTC", { id: "d", start: { date: "2026-11-01" }, end: { date: "2026-11-01" } }).kind).toBe("skip");
    expect(toEventMeta("c", "UTC", { id: "d", start: { date: "2026-13-01" }, end: { date: "2026-13-02" } }).kind).toBe("skip");
    expect(toEventMeta("c", "Not/AZone", { id: "d", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } }).kind).toBe("skip");
  });

  it("never invents a time: missing, malformed or reversed times skip the event", () => {
    expect(toEventMeta("c", "UTC", { id: "e", start: {}, end: {} }).kind).toBe("skip");
    expect(toEventMeta("c", "UTC", { id: "e", start: { dateTime: "yesterday" }, end: { dateTime: "today" } }).kind).toBe("skip");
    expect(toEventMeta("c", "UTC", { id: "e", start: { dateTime: "2026-10-21T15:00:00Z" }, end: { dateTime: "2026-10-21T14:00:00Z" } }).kind).toBe("skip");
    expect(toEventMeta("c", "UTC", { id: "e", start: { date: "2026-10-21" }, end: { dateTime: "2026-10-22T00:00:00Z" } }).kind).toBe("skip");
    expect(toEventMeta("c", "UTC", { id: "e", status: "weird", start: { dateTime: "2026-10-21T14:00:00Z" }, end: { dateTime: "2026-10-21T15:00:00Z" } })).toEqual({ kind: "skip", reason: "unknown_status" });
    expect(toEventMeta("c", "UTC", "nope").kind).toBe("skip");
    // no `updated` -> no version, not "now"
    expect(meta(toEventMeta("c", "UTC", timed({ updated: undefined }))).source_updated_at).toBeNull();
  });

  it("a cancelled item is a stub: ids, version and recurrence link only, whatever else Google sent", () => {
    const stub = meta(
      toEventMeta("primary", "America/New_York", {
        id: "ser1_20261023T140000Z",
        status: "cancelled",
        updated: "2026-10-05T10:00:00.000Z",
        summary: "Cancelled meeting",
        location: "Room 9",
        start: { dateTime: "2026-10-23T10:00:00-04:00" },
        end: { dateTime: "2026-10-23T11:00:00-04:00" },
        attendees: [{ email: "a@example.test" }],
        recurringEventId: "ser1",
        originalStartTime: { dateTime: "2026-10-23T14:00:00Z" },
      }),
    );
    expect(stub).toMatchObject({ event_id: "ser1_20261023T140000Z", status: "cancelled", start_at: null, end_at: null, title: null, location: null, attendees: [], all_day: false, recurring_event_id: "ser1", original_start_at: "2026-10-23T14:00:00.000Z", source_updated_at: "2026-10-05T10:00:00.000Z" });
    const minimal = meta(toEventMeta("primary", "UTC", { id: "gone", status: "cancelled" }));
    expect(minimal).toMatchObject({ status: "cancelled", source_updated_at: null, recurring_event_id: null, original_start_at: null });
  });

  it("recurring instances carry the series id and the original start", () => {
    const e = meta(toEventMeta("primary", "UTC", timed({ id: "s_20261022T130000Z", recurringEventId: "s", originalStartTime: { dateTime: "2026-10-22T13:00:00Z" } })));
    expect(e).toMatchObject({ recurring_event_id: "s", original_start_at: "2026-10-22T13:00:00.000Z" });
    const allDayInstance = meta(toEventMeta("primary", "America/New_York", { id: "s_20261101", recurringEventId: "s", originalStartTime: { date: "2026-11-01" }, start: { date: "2026-11-01" }, end: { date: "2026-11-02" } }));
    expect(allDayInstance.original_start_at).toBe("2026-11-01T04:00:00.000Z");
  });

  it("meeting link: hangoutLink or a video entry point, https only; the description and attachments are never carried", () => {
    expect(meta(toEventMeta("c", "UTC", timed({ hangoutLink: "https://meet.google.com/aaa-bbbb-ccc" }))).online_meeting_url).toBe("https://meet.google.com/aaa-bbbb-ccc");
    expect(
      meta(toEventMeta("c", "UTC", timed({ conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1555" }, { entryPointType: "video", uri: "http://insecure.example.test/x" }, { entryPointType: "video", uri: "https://zoom.example.test/j/1" }] } }))).online_meeting_url,
    ).toBe("https://zoom.example.test/j/1");
    expect(meta(toEventMeta("c", "UTC", timed({ hangoutLink: "javascript:alert(1)" }))).online_meeting_url).toBeNull();
    expect(meta(toEventMeta("c", "UTC", timed({ hangoutLink: "https://a.example.test/x y" }))).online_meeting_url).toBeNull();
    const e = meta(toEventMeta("c", "UTC", timed({ description: "SECRET-DESCRIPTION", attachments: [{ fileUrl: "https://x.example.test" }] })));
    expect(JSON.stringify(e)).not.toContain("SECRET-DESCRIPTION");
    expect(Object.keys(e)).not.toContain("description");
  });

  it("other people's text is cleaned and bounded: controls and bidi stripped, long values cut, bad parts dropped without losing the event", () => {
    const e = meta(toEventMeta("c", "UTC", timed({ summary: "Pay‮ now\u0000\n  please", location: "L".repeat(50_000), organizer: { email: "boss@example.test", displayName: "N".repeat(5000) } })));
    expect(e.title).toBe("Pay now please");
    expect(e.location).toHaveLength(1000);
    expect(e.organizer_name).toHaveLength(200);
    expect(EventMetaSchema.safeParse(e).success).toBe(true);
    // an id longer than the table allows cannot be indexed: skipped, not wedged
    expect(toEventMeta("c", "UTC", timed({ id: "i".repeat(600) })).kind).toBe("skip");
    // a malformed attendee address is dropped, the event stays
    const odd = meta(toEventMeta("c", "UTC", timed({ attendees: [{ email: "not an address" }, { email: "ok@example.test" }, {}] })));
    expect(odd.attendees.map((a) => a.email)).toEqual(["ok@example.test"]);
  });

  it("caps attendees at 500 entries and 100 kB serialized; a hostile summary is processed in linear time", () => {
    const many = Array.from({ length: 2000 }, (_v, i) => ({ email: `p${String(i)}@example.test`, displayName: "N".repeat(200) }));
    const e = meta(toEventMeta("c", "UTC", timed({ attendees: many })));
    expect(e.attendees.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(e.attendees).length).toBeLessThanOrEqual(100_100);
    const t = Date.now();
    toEventMeta("c", "UTC", timed({ summary: `${" \t".repeat(40_000)}x`, location: "\u0000".repeat(90_000) }));
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe("composite cursor", () => {
  const FP = "0123456789ab";
  const state: CursorState = {
    d: true,
    s: FP,
    i: 1,
    cals: [
      { id: "primary", t: "CPDAlvWDx70DEPDAlvWDx70DGAU=", pt: null, from: 20000, to: 20365 },
      { id: "c_x@group.calendar.google.com", t: null, pt: "ep250", from: 20000, to: 20365 },
    ],
  };

  it("round-trips and binds the connection", () => {
    const { value } = encodeCalendarCursor(CONN, state);
    expect(value.startsWith(`g1.${CONN}.c:`)).toBe(true);
    expect(parseCalendarCursor(value, CONN)).toEqual(state);
    expect(parseCalendarCursor(value, "00000000-0000-4000-8000-000000000999")).toBeNull();
  });

  it("anything malformed, tampered or inconsistent is null (-> fullResyncRequired)", () => {
    const { value } = encodeCalendarCursor(CONN, state);
    const body = (s: unknown) => `g1.${CONN}.c:${Buffer.from(JSON.stringify(s)).toString("base64url")}`;
    for (const bad of ["stale-token", "", `g1.${CONN}.c:`, `g1.${CONN}.c:!!!`, `g1.${CONN}.h:123`, `${value}x$`, body({ i: 0, cals: "x" }), body({ i: 5, cals: state.cals }), body({ ...state, extra: 1 }), body({ i: 0, cals: [{ ...state.cals[0], pt: "p" }, state.cals[1]] }), body({ i: 0, cals: [state.cals[0], state.cals[0]] }), body({ i: 0, cals: [{ ...state.cals[0], t: "bad token!" }] })]) {
      expect(parseCalendarCursor(bad, CONN), bad).toBeNull();
    }
  });

  it("the largest state the limits allow (10 calendars, longest ids and tokens, one page token) fits the 16 KB cursor; junk parses in linear time", () => {
    const big: CursorState = { d: true, s: FP, i: 9, cals: Array.from({ length: 10 }, (_v, k) => ({ id: `${String(k)}${"c".repeat(199)}`, t: "T".repeat(700), pt: k === 9 ? "P".repeat(700) : null, from: 1_000_000, to: 1_000_000 })) };
    const { value } = encodeCalendarCursor(CONN, big);
    expect(value.length).toBeLessThan(16_384);
    expect(parseCalendarCursor(value, CONN)).toEqual(big);
    const t = Date.now();
    parseCalendarCursor(`g1.${CONN}.c:${"A".repeat(16_000)}`, CONN);
    parseCalendarCursor(`g1.${CONN}.c:${"A".repeat(200_000)}`, CONN);
    expect(Date.now() - t).toBeLessThan(500);
  });
});
