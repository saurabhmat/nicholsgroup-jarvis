import { describe, expect, it } from "vitest";
import { businessDay, homeFor, loadHome, toAttention, toMeetings, type HomeMeeting } from "./home";

const iso = (d: Date) => d.toISOString();

describe("businessDay (America/New_York)", () => {
  it("is midnight to midnight New York time on an ordinary day (EST, UTC-5)", () => {
    const { from, to } = businessDay(new Date("2026-11-06T17:00:00Z"));
    expect([iso(from), iso(to)]).toEqual(["2026-11-06T05:00:00.000Z", "2026-11-07T05:00:00.000Z"]);
  });

  it("late evening in New York is still that day, although it is already tomorrow in UTC", () => {
    const { from } = businessDay(new Date("2026-11-07T03:30:00Z")); // 22:30 on Nov 6 in New York
    expect(iso(from)).toBe("2026-11-06T05:00:00.000Z");
  });

  it("the day clocks fall back is 25 hours long", () => {
    const { from, to } = businessDay(new Date("2026-11-01T15:00:00Z"));
    expect([iso(from), iso(to)]).toEqual(["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
  });

  it("the day clocks spring forward is 23 hours long", () => {
    const { from, to } = businessDay(new Date("2026-03-08T15:00:00Z"));
    expect([iso(from), iso(to)]).toEqual(["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
  });
});

describe("toMeetings", () => {
  it("keeps https links only and fills a missing title", () => {
    const [m] = toMeetings([
      { title: "", start_at: "2026-11-06T14:30:00Z", end_at: "2026-11-06T15:00:00Z", all_day: false, location: "Room 1", source_url: "javascript:alert(1)", online_meeting_url: "https://meet.example.test/x" },
    ]);
    expect(m).toMatchObject({ title: "(No title)", calendarUrl: null, meetingUrl: "https://meet.example.test/x", location: "Room 1", allDay: false });
  });

  it("drops rows without valid times and tolerates non-arrays", () => {
    expect(toMeetings([{ title: "x", start_at: "nope", end_at: null }])).toEqual([]);
    expect(toMeetings(null)).toEqual([]);
  });
});

describe("toAttention", () => {
  const now = new Date("2026-11-06T14:00:00Z"); // 9:00 New York
  const meetings: HomeMeeting[] = [
    { title: "Offsite", startAt: "2026-11-06T05:00:00Z", endAt: "2026-11-07T05:00:00Z", allDay: true, location: null, calendarUrl: null, meetingUrl: null },
    { title: "Earlier", startAt: "2026-11-06T13:00:00Z", endAt: "2026-11-06T13:30:00Z", allDay: false, location: null, calendarUrl: null, meetingUrl: null },
    { title: "Leadership sync", startAt: "2026-11-06T14:30:00Z", endAt: "2026-11-06T15:00:00Z", allDay: false, location: null, calendarUrl: null, meetingUrl: null },
  ];

  it("lists feed problems, the next timed meeting and mail counts, in that order", () => {
    const items = toAttention({
      connections: [
        { provider: "quickbooks", status: "reconnect_required" },
        { provider: "google", status: "active" },
        { provider: "stripe", status: "degraded" },
      ],
      meetings,
      mail: { unread_important: 3, unread_priority: 1, priority_configured: true },
      now,
    });
    expect(items.map((i) => i.label)).toEqual([
      "QuickBooks needs reconnecting",
      "Stripe connection has problems",
      "Next: Leadership sync 9:30 AM",
      "3 unread important emails in the last 24 hours",
      "1 unread from priority senders",
    ]);
    expect(items.map((i) => i.segment)).toEqual(["settings", "settings", "calendar", "inbox", "inbox"]);
  });

  it("shows nothing for healthy feeds, no meetings ahead, zero counts or no priority list", () => {
    expect(toAttention({ connections: [{ provider: "google", status: "active" }], meetings: meetings.slice(0, 2), mail: { unread_important: 0, unread_priority: 4, priority_configured: false }, now })).toEqual([]);
    expect(toAttention({ connections: [], meetings: [], mail: null, now })).toEqual([]);
  });

  it("two problem connections of the same provider get distinct keys", () => {
    const items = toAttention({ connections: [{ id: "a", provider: "google", status: "degraded" }, { id: "b", provider: "google", status: "reconnect_required" }], meetings: [], mail: null, now });
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });
});

describe("loadHome / homeFor", () => {
  type Result = { data: unknown; error: unknown };
  const ok = (data: unknown): Result => ({ data, error: null });
  const fakeClient = (r: { conns: Result; meetings: Result; mail: Result; calendar?: Result }, calls: unknown[] = []) => ({
    schema: () => ({
      from: () => ({ select: () => ({ eq: (_c: string, lane: string) => (calls.push(["connections", lane]), Promise.resolve(r.conns)) }) }),
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push([fn, args]);
        const res = { home_meetings: r.meetings, home_mail_attention: r.mail, home_calendar_status: r.calendar ?? ok("connected") }[fn];
        return Promise.resolve(res);
      },
    }),
  });
  const meetingRow = { title: "Sync", start_at: "2026-11-06T15:00:00Z", end_at: "2026-11-06T15:30:00Z", all_day: false };
  const now = new Date("2026-11-06T14:00:00Z");

  it("asks for today's window and this lane only", async () => {
    const calls: unknown[] = [];
    const client = fakeClient({ conns: { data: [{ provider: "google", status: "active" }], error: null }, meetings: { data: [], error: null }, mail: { data: [{ unread_important: 0, unread_priority: 0, priority_configured: false }], error: null } }, calls);
    const view = await loadHome(client as never, "PKG", now);
    expect(view).toEqual({ calendar: "connected", meetings: [], attention: [] });
    expect(calls).toContainEqual(["connections", "PKG"]);
    expect(calls).toContainEqual(["home_calendar_status", { p_lane: "PKG" }]);
    expect(calls).toContainEqual(["home_meetings", { p_lane: "PKG", p_from: "2026-11-06T05:00:00.000Z", p_to: "2026-11-07T05:00:00.000Z" }]);
    expect(calls).toContainEqual(["home_mail_attention", { p_lane: "PKG", p_since: "2026-11-05T14:00:00.000Z" }]); // last 24 h
  });

  it("the calendar state comes from calendar access, not from the connections view", async () => {
    // A viewer granted the calendar view but not the connections view: no connection rows, yet meetings show.
    const viewer = fakeClient({ conns: ok([]), meetings: ok([meetingRow]), mail: ok([]), calendar: ok("connected") });
    expect(await loadHome(viewer as never, "PKG", now)).toMatchObject({ calendar: "connected", meetings: [{ title: "Sync" }] });
    // admin_technical: connections visible, no calendar view -> no_access, never "nothing scheduled".
    const admin = fakeClient({ conns: ok([{ id: "g", provider: "google", status: "active" }]), meetings: ok([]), mail: ok([]), calendar: ok("no_access") });
    expect(await loadHome(admin as never, "PKG", now)).toMatchObject({ calendar: "no_access", meetings: [] });
    const none = fakeClient({ conns: ok([]), meetings: ok([meetingRow]), mail: ok([]), calendar: ok("not_connected") });
    expect(await loadHome(none as never, "PKG", now)).toMatchObject({ calendar: "not_connected", meetings: [] });
  });

  it("a database error becomes 'unavailable', never an empty day", async () => {
    const client = fakeClient({ conns: { data: [], error: null }, meetings: { data: null, error: { message: "x" } }, mail: { data: [], error: null } });
    const g = { requireLane: async () => ({ client }) as never };
    expect(await homeFor(g, "PKG", now)).toEqual({ calendar: "no_access", meetings: [], attention: [], unavailable: true });
  });

  it("an authorization failure from the lane gate is not swallowed", async () => {
    const g = { requireLane: async () => { throw new Error("forbidden"); } };
    await expect(homeFor(g, "PKG", now)).rejects.toThrow("forbidden");
  });
});
