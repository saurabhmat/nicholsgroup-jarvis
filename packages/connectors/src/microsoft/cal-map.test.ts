// The strict mapper of the Microsoft calendar sync (T-067, spec §9): field mapping, UTC times, all-day events and their zone table, cancelled events as
// stubs, recurring instances, the https and host rules for links, the caps on what the documentation leaves unbounded, and that nothing outside the mapping
// (a body above all) reaches the record. Synthetic data only.
import { describe, expect, it } from "vitest";
import { EventMetaSchema } from "../comms/schemas";
import { CAL_BODY_CANARY, CAL_PREVIEW_CANARY, CAL_SERIES_CANARY } from "../testing/msw/microsoft/calendar";
import { DEFAULT_CALENDAR_ID } from "./cal-cursor";
import { mapEvent, MAX_ATTENDEES, removalOf, type CalOutcome } from "./cal-map";

const ev = (over: Record<string, unknown> = {}) => ({
  id: "AAMkEvent1=",
  iCalUId: "040000008200E00074C5B7101A82E008",
  subject: "Quarterly review",
  bodyPreview: CAL_PREVIEW_CANARY,
  body: { contentType: "html", content: `<p>${CAL_BODY_CANARY}</p>` },
  webLink: "https://outlook.office365.com/calendar/item/AAMkEvent1%3D",
  isAllDay: false,
  isCancelled: false,
  type: "singleInstance",
  seriesMasterId: null,
  start: { dateTime: "2026-11-06T15:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-06T16:00:00.0000000", timeZone: "UTC" },
  originalStart: null,
  originalStartTimeZone: "Pacific Standard Time",
  lastModifiedDateTime: "2026-11-04T10:01:00Z",
  location: { displayName: "Board room" },
  organizer: { emailAddress: { address: "Boss@Example.Test", name: "The Boss" } },
  attendees: [{ status: { response: "accepted" }, emailAddress: { address: "Exec@Example.Test", name: "Exec" } }],
  onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
  onlineMeetingUrl: `https://deprecated.example.test/${CAL_SERIES_CANARY}`,
  ...over,
});
const meta = (raw: unknown) => {
  const r: CalOutcome = mapEvent(raw);
  if (r.kind !== "event") throw new Error(`expected a record, got ${r.reason}`);
  return r.meta;
};
const skipped = (raw: unknown) => {
  const r = mapEvent(raw);
  if (r.kind !== "skip") throw new Error("expected a skip");
  return r.reason;
};

describe("field mapping (spec §9)", () => {
  it("maps every index field of a timed event; a dateTime without an offset is UTC", () => {
    expect(meta(ev())).toEqual({
      calendar_id: DEFAULT_CALENDAR_ID,
      event_id: "AAMkEvent1=",
      ical_uid: "040000008200E00074C5B7101A82E008",
      source_url: "https://outlook.office365.com/calendar/item/AAMkEvent1%3D",
      title: "Quarterly review",
      location: "Board room",
      organizer_email: "boss@example.test",
      organizer_name: "The Boss",
      start_at: "2026-11-06T15:00:00.000Z",
      end_at: "2026-11-06T16:00:00.000Z",
      all_day: false,
      start_date: null,
      end_date: null,
      timezone: "America/Los_Angeles",
      attendees: [{ email: "exec@example.test", name: "Exec", response: "accepted" }],
      status: "confirmed",
      recurring_event_id: null,
      original_start_at: null,
      online_meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
      source_updated_at: "2026-11-04T10:01:00.000Z",
    });
  });

  it("an offset in the dateTime is honoured; a timed event in an unlisted original zone keeps timezone null (timed events need no table)", () => {
    const m = meta(ev({ start: { dateTime: "2026-11-06T10:00:00+02:00", timeZone: "UTC" }, end: { dateTime: "2026-11-06T11:00:00Z", timeZone: "utc" }, originalStartTimeZone: "tzone://Microsoft/Custom" }));
    expect(m.start_at).toBe("2026-11-06T08:00:00.000Z");
    expect(m.end_at).toBe("2026-11-06T11:00:00.000Z");
    expect(m.timezone).toBeNull();
  });

  it("every record passes the strict schema and has no field for a description", () => {
    const m = meta(ev());
    expect(EventMetaSchema.safeParse(m).success).toBe(true);
    expect(Object.keys(m).some((k) => /body|description|preview/i.test(k))).toBe(false);
  });
});

describe("rule 6: no body, preview or other undeclared field reaches the record", () => {
  it("the body, the preview and a deprecated field are in the input and in no output field", () => {
    const text = JSON.stringify(meta(ev({ extra: { nested: CAL_BODY_CANARY }, attachments: [{ name: CAL_BODY_CANARY }], uniqueBody: { content: CAL_BODY_CANARY } })));
    for (const c of [CAL_BODY_CANARY, CAL_PREVIEW_CANARY, CAL_SERIES_CANARY]) expect(text).not.toContain(c);
  });
  it("a cancelled stub carries none of it either", () => {
    const text = JSON.stringify(meta(ev({ isCancelled: true })));
    for (const c of [CAL_BODY_CANARY, CAL_PREVIEW_CANARY, CAL_SERIES_CANARY]) expect(text).not.toContain(c);
  });
});

describe("time zones", () => {
  it("an event whose answered zone is not UTC is skipped, never converted by guess", () => {
    expect(skipped(ev({ start: { dateTime: "2026-11-06T07:00:00.0000000", timeZone: "Pacific Standard Time" } }))).toBe("not_utc");
    expect(skipped(ev({ end: { dateTime: "2026-11-06T08:00:00.0000000", timeZone: "Eastern Standard Time" } }))).toBe("not_utc");
    expect(skipped(ev({ start: { dateTime: "2026-11-06T07:00:00.0000000" } }))).toBe("not_utc");
  });
  it("missing, malformed or reversed times are skipped (never a now() fallback)", () => {
    expect(skipped(ev({ start: null }))).toBe("invalid_times");
    expect(skipped(ev({ end: { dateTime: "not a time", timeZone: "UTC" } }))).toBe("invalid_times");
    expect(skipped(ev({ start: { dateTime: "2026-11-06T17:00:00.0000000", timeZone: "UTC" } }))).toBe("invalid_event"); // end before start fails the strict schema
  });
});

describe("all-day events: midnight in the event's own zone, the zone from the table or the event is skipped", () => {
  const allDay = (zone: unknown, start: string, end: string, over: Record<string, unknown> = {}) => ev({ isAllDay: true, originalStartTimeZone: zone, start: { dateTime: start, timeZone: "UTC" }, end: { dateTime: end, timeZone: "UTC" }, ...over });

  it("a mapped zone: Eastern, across the 2026-11-01 DST change (start in EDT, end in EST)", () => {
    const m = meta(allDay("Eastern Standard Time", "2026-10-31T04:00:00.0000000", "2026-11-02T05:00:00.0000000"));
    expect(m).toMatchObject({ all_day: true, start_date: "2026-10-31", end_date: "2026-11-02", timezone: "America/New_York", start_at: "2026-10-31T04:00:00.000Z", end_at: "2026-11-02T05:00:00.000Z" });
  });
  it("Pacific, a one-day event; and a zone east of UTC (India)", () => {
    expect(meta(allDay("Pacific Standard Time", "2026-11-10T08:00:00.0000000", "2026-11-11T08:00:00.0000000"))).toMatchObject({ start_date: "2026-11-10", end_date: "2026-11-11", timezone: "America/Los_Angeles" });
    expect(meta(allDay("India Standard Time", "2026-11-09T18:30:00.0000000", "2026-11-10T18:30:00.0000000"))).toMatchObject({ start_date: "2026-11-10", end_date: "2026-11-11", timezone: "Asia/Kolkata" });
    expect(meta(allDay("UTC", "2026-11-10T00:00:00.0000000", "2026-11-11T00:00:00.0000000"))).toMatchObject({ start_date: "2026-11-10", timezone: "UTC" });
  });
  it("a zone missing from the table, the custom marker, a missing zone and an invalid IANA-looking name are skipped (a non-string zone is an invalid item)", () => {
    for (const z of ["Synthetic Standard Time", "tzone://Microsoft/Custom", null, undefined, "Mars/Olympus"]) {
      expect(skipped(allDay(z, "2026-11-10T08:00:00.0000000", "2026-11-11T08:00:00.0000000")), String(z)).toBe("all_day_zone_unusable");
    }
  });
  it("instants that are not local midnights of the zone, a zero-length or reversed event are skipped, never guessed", () => {
    expect(skipped(allDay("Pacific Standard Time", "2026-11-10T00:00:00.0000000", "2026-11-11T00:00:00.0000000"))).toBe("invalid_all_day"); // midnight UTC is not midnight Pacific
    expect(skipped(allDay("Pacific Standard Time", "2026-11-10T08:00:00.0000000", "2026-11-10T08:00:00.0000000"))).toBe("invalid_all_day");
    expect(skipped(allDay("Pacific Standard Time", "2026-11-11T08:00:00.0000000", "2026-11-10T08:00:00.0000000"))).toBe("invalid_all_day");
  });
  it("an all-day event answered in a non-UTC zone is skipped for that reason", () => {
    expect(skipped(allDay("Pacific Standard Time", "2026-11-10T08:00:00.0000000", "2026-11-11T08:00:00.0000000", { start: { dateTime: "2026-11-10T00:00:00.0000000", timeZone: "Pacific Standard Time" } }))).toBe("not_utc");
  });
});

describe("cancelled events and removals", () => {
  it("isCancelled true is a stub: status cancelled, no times, nothing else but the ids, the series link and the version", () => {
    const m = meta(ev({ isCancelled: true, type: "occurrence", seriesMasterId: "AAMkSeries=", originalStart: "2026-11-06T15:00:00Z" }));
    expect(m).toMatchObject({ status: "cancelled", start_at: null, end_at: null, title: null, attendees: [], recurring_event_id: "AAMkSeries=", original_start_at: "2026-11-06T15:00:00.000Z", source_updated_at: "2026-11-04T10:01:00.000Z", event_id: "AAMkEvent1=" });
  });
  it("an `@removed` entry maps to a removal of the default calendar's row; an unusable id is null (counted by the caller)", () => {
    expect(removalOf({ id: "AAMkGone=", "@removed": { reason: "deleted" } })).toEqual({ calendar_id: DEFAULT_CALENDAR_ID, event_id: "AAMkGone=" });
    for (const bad of [{ "@removed": {} }, { id: "" }, { id: 5 }, { id: "a\u0007b" }, { id: "x".repeat(513) }, null, "x"]) expect(removalOf(bad)).toBeNull();
  });
});

describe("recurring events: occurrences and exceptions are instances; the series master is not an event", () => {
  it("seriesMasterId becomes recurring_event_id and originalStart the original start of the instance", () => {
    for (const type of ["occurrence", "exception"]) {
      const m = meta(ev({ type, seriesMasterId: "AAMkSeries=", originalStart: "2026-11-06T15:00:00.0000000Z" }));
      expect(m).toMatchObject({ recurring_event_id: "AAMkSeries=", original_start_at: "2026-11-06T15:00:00.000Z", status: "confirmed" });
      expect(m.event_id).not.toBe(m.recurring_event_id);
    }
  });
  it("a single instance has no series link, and an original start without a series is not kept", () => {
    expect(meta(ev({ originalStart: "2026-11-06T15:00:00Z" }))).toMatchObject({ recurring_event_id: null, original_start_at: null });
  });
  it("a seriesMaster item is skipped (it would be a second copy of the first occurrence)", () => {
    expect(skipped(ev({ type: "seriesMaster" }))).toBe("series_master");
  });
});

describe("links", () => {
  it("webLink: https on the allow-listed Outlook hosts, normalised; anything else is null (never a wrong link)", () => {
    expect(meta(ev({ webLink: "https://outlook.office.com/calendar/item/x" })).source_url).toBe("https://outlook.office.com/calendar/item/x");
    for (const l of ["http://outlook.office365.com/x", "https://evil.example.test/x", "https://outlook.office365.com.evil.example.test/x", "https://user@outlook.office365.com/x", "https://outlook.office365.com:444/x", "javascript:alert(1)", "https://outlook.office365.com/a b", "https://outlook.office365.com/\\x", "", null]) {
      expect(meta(ev({ webLink: l })).source_url, String(l)).toBeNull();
    }
  });
  it("onlineMeeting.joinUrl: https only; the deprecated onlineMeetingUrl is never used", () => {
    for (const l of ["http://teams.microsoft.com/x", "javascript:alert(1)", "ftp://x.example.test/a", "https://user:pw@teams.example.test/x", "https://x.example.test/a b", "https://x.example.test/" + "a".repeat(2100), "", null]) {
      expect(meta(ev({ onlineMeeting: { joinUrl: l } })).online_meeting_url, String(l)).toBeNull();
    }
    expect(meta(ev({ onlineMeeting: null, onlineMeetingUrl: "https://teams.microsoft.com/deprecated" })).online_meeting_url).toBeNull();
  });
});

describe("text and attendees are untrusted: cleaned, bounded, one bad part never costs the event", () => {
  it("bidi and control characters are removed from the subject, the location and the names; text is bounded", () => {
    const m = meta(ev({ subject: "Pay‮evil\u0007 now !", location: { displayName: "Room⁦ 1\u0000" }, organizer: { emailAddress: { address: "boss@example.test", name: "Bo‮ss" } } }));
    expect(m.title).toBe("Pay evil now !");
    expect(m.location).toBe("Room 1");
    expect(m.organizer_name).toBe("Bo ss");
    const long = meta(ev({ subject: "s".repeat(50_000), location: { displayName: "l".repeat(50_000) } }));
    expect(long.title).toHaveLength(1000);
    expect(long.location).toHaveLength(1000);
  });
  it("a bad organizer or attendee ADDRESS is dropped, the event and the other attendees are kept", () => {
    const m = meta(ev({ organizer: { emailAddress: { address: "not an address", name: "X" } }, attendees: [{ emailAddress: { address: "bad‮@example.test" } }, { emailAddress: { address: "a b@example.test" } }, { emailAddress: { address: "ok@example.test", name: "Ok" }, status: { response: "tentativelyAccepted" } }, { emailAddress: null }, { emailAddress: { address: "late@example.test" }, status: { response: "notResponded" } }, { emailAddress: { address: "gone@example.test" }, status: { response: "declined" } }] }));
    expect(m.organizer_email).toBeNull();
    expect(m.attendees).toEqual([{ email: "ok@example.test", name: "Ok", response: "tentative" }, { email: "late@example.test", response: "needs_action" }, { email: "gone@example.test", response: "declined" }]);
  });
  it("attendees are capped at 500, Microsoft's documented maximum", () => {
    const attendees = Array.from({ length: 700 }, (_, i) => ({ emailAddress: { address: `p${String(i)}@example.test` } }));
    expect(meta(ev({ attendees })).attendees).toHaveLength(MAX_ATTENDEES);
    expect(MAX_ATTENDEES).toBe(500);
  });
  it("a field that breaks a table limit clears only that field (an oversized iCalUId), never the event", () => {
    const m = meta(ev({ iCalUId: "u".repeat(600), webLink: "https://outlook.office365.com/" + "a".repeat(2100) }));
    expect(m).toMatchObject({ ical_uid: null, source_url: null, title: "Quarterly review", event_id: "AAMkEvent1=" });
  });
});

describe("malformed items are a counted skip, never a throw", () => {
  it("non-objects, an id that is empty, too long or has controls, and wrong types", () => {
    for (const bad of [null, "x", 5, [], {}, { id: "" }, { id: "a\u0007" }, { id: "x".repeat(513) }, ev({ id: 5 }), ev({ start: "2026-11-06" }), ev({ attendees: "x" }), ev({ isAllDay: "yes" })]) {
      expect(mapEvent(bad).kind, JSON.stringify(bad)?.slice(0, 40)).toBe("skip");
    }
  });
});

describe("review fixes (T-067): attendees, IANA zones, join link, impossible dates", () => {
  const att = (a: string, extra: Record<string, unknown> = {}) => ({ emailAddress: { address: a }, ...extra });
  it("a response named toString, constructor or __proto__ keeps the attendee (no response) and the others", () => {
    const m = meta(ev({ attendees: [att("a@example.test", { status: { response: "toString" } }), att("b@example.test", { status: { response: "constructor" } }), att("c@example.test", { status: { response: "__proto__" } }), att("d@example.test", { status: { response: "accepted" } })] }));
    expect(m.attendees).toEqual([{ email: "a@example.test" }, { email: "b@example.test" }, { email: "c@example.test" }, { email: "d@example.test", response: "accepted" }]);
  });
  it("one malformed attendee (non-string address, over-long response, a string) costs only itself", () => {
    const m = meta(ev({ attendees: [att("a@example.test"), { emailAddress: { address: 5 } }, att("b@example.test", { status: { response: "x".repeat(100) } }), "x", null, att("c@example.test")] }));
    expect(m.attendees.map((a) => a.email)).toEqual(["a@example.test", "c@example.test"]);
  });
  it("6,000 attendees keeps the event with a list capped at 500 and reports the truncation", () => {
    const r = mapEvent(ev({ attendees: Array.from({ length: 6000 }, (_, i) => att(`p${String(i)}@example.test`)) }));
    expect(r.kind).toBe("event");
    if (r.kind === "event") {
      expect(r.meta.attendees).toHaveLength(500);
      expect(r.attendeesTruncated).toBe(true);
    }
    const small = mapEvent(ev());
    expect(small.kind === "event" && small.attendeesTruncated).toBeFalsy();
  });
  it("an all-day event with an IANA zone name is accepted; the local-midnight check still applies", () => {
    const allDay = (zone: string, s: string, e: string) => ev({ isAllDay: true, originalStartTimeZone: zone, start: { dateTime: s, timeZone: "UTC" }, end: { dateTime: e, timeZone: "UTC" } });
    expect(meta(allDay("Europe/London", "2026-11-10T00:00:00.0000000", "2026-11-11T00:00:00.0000000"))).toMatchObject({ timezone: "Europe/London", start_date: "2026-11-10" });
    expect(skipped(allDay("America/Santiago", "2026-11-10T00:00:00.0000000", "2026-11-11T00:00:00.0000000"))).toBe("invalid_all_day");
  });
  it("joinUrl is stored normalised; backslashes, %5c, non-ASCII and credentials are refused", () => {
    expect(meta(ev({ onlineMeeting: { joinUrl: "https://TEAMS.example.test/a b".replace(" ", "%20") } })).online_meeting_url).toBe("https://teams.example.test/a%20b");
    for (const l of ["https://x.example.test/a\\b", "https://x.example.test/a%5Cb", "https://x.example.test/a%5cb", "https://x.example.test/\u00e9", "https://u:p@x.example.test/"]) {
      expect(meta(ev({ onlineMeeting: { joinUrl: l } })).online_meeting_url, l).toBeNull();
    }
  });
  it("an impossible date is an unusable time", () => {
    expect(skipped(ev({ start: { dateTime: "2026-02-30T10:00:00.0000000", timeZone: "UTC" } }))).toBe("invalid_times");
  });
});
