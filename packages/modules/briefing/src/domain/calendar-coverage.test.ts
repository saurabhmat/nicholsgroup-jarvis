import { describe, expect, it } from "vitest";
import { analyzeDay, notableAhead, parseEvents, attendeeSummary } from "./calendar";
import { coverageLine, parseCoverageRows, toCoverage } from "./coverage";
import { dayWindow, timeWithZone, validTimeZone } from "./time";

const owners = new Set(["me@pubk.test"]);
const internal = new Set(["pubk.test"]);

const ev = (over: Record<string, unknown>) => ({
  connection_id: "c1",
  calendar_id: "primary",
  event_id: String(over.event_id ?? over.title),
  title: "Meeting",
  start_at: "2026-11-12T14:00:00Z",
  end_at: "2026-11-12T15:00:00Z",
  all_day: false,
  attendees: [],
  ...over,
});

describe("calendar analysis", () => {
  it("hides declined events and flags clashes, back-to-backs, RSVP pending and external attendees", () => {
    const events = parseEvents([
      ev({ title: "A", start_at: "2026-11-12T14:00:00Z", end_at: "2026-11-12T15:00:00Z", attendees: [{ email: "me@pubk.test", response: "needs_action" }, { email: "x@outside.test", name: "X Person" }] }),
      ev({ title: "B", start_at: "2026-11-12T14:30:00Z", end_at: "2026-11-12T15:30:00Z", attendees: [{ email: "me@pubk.test", response: "accepted" }] }),
      ev({ title: "C", start_at: "2026-11-12T15:33:00Z", end_at: "2026-11-12T16:00:00Z" }),
      ev({ title: "Declined", start_at: "2026-11-12T17:00:00Z", end_at: "2026-11-12T18:00:00Z", attendees: [{ email: "ME@pubk.test", response: "declined" }] }),
    ]);
    const day = analyzeDay(events, owners, internal);
    expect(day.map((e) => e.title)).toEqual(["A", "B", "C"]);
    const [a, b, c] = day;
    expect(a?.clashesWith).toEqual(["B"]);
    expect(b?.clashesWith).toEqual(["A"]);
    expect(a?.rsvpPending).toBe(true);
    expect(b?.rsvpPending).toBe(false);
    expect(a?.external).toEqual(["x@outside.test"]);
    expect(c?.backToBack).toBe(true);
    expect(c?.clashesWith).toEqual([]);
    expect(a && attendeeSummary(a, owners)).toBe("X Person");
  });

  it("the same invitation from two calendars (same title and times) shows once and does not clash with itself", () => {
    const day = analyzeDay(parseEvents([ev({ title: "Sync", event_id: "a", calendar_id: "c1" }), ev({ title: "Sync", event_id: "b", calendar_id: "c2" })]), owners, internal);
    expect(day).toHaveLength(1);
    expect(day[0]?.clashesWith).toEqual([]);
  });

  it("all-day events never clash and are not back-to-back", () => {
    const day = analyzeDay(parseEvents([ev({ title: "Offsite", all_day: true, start_at: "2026-11-12T05:00:00Z", end_at: "2026-11-13T05:00:00Z" }), ev({ title: "A" })]), owners, internal);
    expect(day.find((e) => e.title === "Offsite")?.clashesWith).toEqual([]);
    expect(day.find((e) => e.title === "A")?.clashesWith).toEqual([]);
  });

  it("look-ahead keeps holidays, all-day, external meetings and open invitations; drops plain internal meetings and declined ones", () => {
    const ahead = notableAhead(
      parseEvents([
        ev({ title: "Internal", attendees: [{ email: "me@pubk.test", response: "accepted" }, { email: "colleague@pubk.test" }] }),
        ev({ title: "Thanksgiving", all_day: true, calendar_id: "en.usa#holiday@group.v.calendar.google.com" }),
        ev({ title: "Client", attendees: [{ email: "client@acme.test" }] }),
        ev({ title: "Invite", attendees: [{ email: "me@pubk.test", response: "needs_action" }] }),
        ev({ title: "No", attendees: [{ email: "me@pubk.test", response: "declined" }, { email: "client@acme.test" }] }),
      ]),
      owners,
      internal,
    );
    expect(ahead.map((e) => [e.title, e.why.join("|")])).toEqual([
      ["Thanksgiving", "Holiday"],
      ["Client", "External: Client"],
      ["Invite", "RSVP pending"],
    ]);
  });

  it("drops rows without times and non-https links", () => {
    const [e] = parseEvents([ev({ source_url: "javascript:alert(1)", online_meeting_url: "http://meet.test/x" }), { title: "bad" }]);
    expect(e?.calendarUrl).toBeNull();
    expect(e?.meetingUrl).toBeNull();
  });
});

describe("time zones", () => {
  it("adds the other zone only when its clock differs", () => {
    expect(timeWithZone("2026-11-12T14:00:00Z", "America/New_York", "America/Los_Angeles")).toBe("9:00 AM (6:00 AM PST)");
    expect(timeWithZone("2026-11-12T14:00:00Z", "America/New_York", "America/Detroit")).toBe("9:00 AM");
    expect(timeWithZone("2026-11-12T14:00:00Z", "America/New_York", null)).toBe("9:00 AM");
    expect(timeWithZone("2026-11-12T14:00:00Z", "America/New_York", "Not/AZone")).toBe("9:00 AM");
  });

  it("validates zone names and computes a DST-safe day", () => {
    expect(validTimeZone("Europe/London")).toBe("Europe/London");
    expect(validTimeZone("<script>")).toBeNull();
    expect(validTimeZone("Mars/Base")).toBeNull();
    const { from, to } = dayWindow(new Date("2026-11-01T12:00:00Z"), "America/New_York"); // DST ends that day: 25 hours
    expect(from.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(to.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("coverage", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const rows = parseCoverageRows([
    { stream: "mail", account: "ops@pubk.test", connection_id: "c1", provider: "google", status: "active", configured: true, last_sync_at: "2026-11-11T11:50:00Z", error_kind: null },
    { stream: "calendar", account: "ops@pubk.test", connection_id: "c1", provider: "google", status: "active", configured: true, last_sync_at: "2026-11-11T06:00:00Z", error_kind: null },
    { stream: "mail", account: "ceo@pubk.test", connection_id: null, provider: null, status: "not_connected", configured: true, last_sync_at: null, error_kind: null },
    { stream: "mail", account: "x@pubk.test", connection_id: "c2", provider: "google", status: "reconnect_required", configured: true, last_sync_at: null, error_kind: "forbidden" },
    { stream: "bogus", account: "y" },
  ]);

  it("gives every stream a state and a fixed reason", () => {
    const items = toCoverage(rows, now, 120);
    expect(items.map((i) => [i.stream, i.account, i.state])).toEqual([
      ["mail", "ops@pubk.test", "ok"],
      ["calendar", "ops@pubk.test", "stale"],
      ["mail", "ceo@pubk.test", "not_connected"],
      ["mail", "x@pubk.test", "error"],
    ]);
    expect(items[1]?.reason).toBe("Last synced 6h ago.");
    expect(items[3]?.reason).toBe("Access was refused. Reconnect in Settings.");
  });

  it("the Coverage line is never empty and names missing access", () => {
    const line = coverageLine(toCoverage(rows, now, 120), true);
    expect(line).toContain("Mail ops@pubk.test up to date");
    expect(line).toContain("Mail ceo@pubk.test: not connected");
    expect(coverageLine([], true)).toMatch(/no mailbox or calendar is set up/);
    expect(coverageLine([], false)).toMatch(/does not include mail or calendar/);
  });
});

describe("provider URLs (rule 9)", () => {
  it("keeps https links normalised and drops credentials, http and script URLs", () => {
    const [a, b, c] = parseEvents([
      ev({ title: "a", source_url: "https://calendar.google.com/e/1", online_meeting_url: "https://meet.google.com@evil.test/x" }),
      ev({ title: "b", source_url: "http://calendar.google.com/e/1", online_meeting_url: "javascript:alert(1)" }),
      ev({ title: "c", source_url: "https://u:p@calendar.google.com/e/1", online_meeting_url: "https://meet.google.com/abc" }),
    ]);
    expect([a?.calendarUrl, a?.meetingUrl]).toEqual(["https://calendar.google.com/e/1", null]);
    expect([b?.calendarUrl, b?.meetingUrl]).toEqual([null, null]);
    expect([c?.calendarUrl, c?.meetingUrl]).toEqual([null, "https://meet.google.com/abc"]);
  });
});
