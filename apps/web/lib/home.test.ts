import { afterEach, describe, expect, it, vi } from "vitest";
import { businessDay, composeBriefing, homeFor, homeKpis, loadHome, toAttention, toMeetings, type HomeMeeting } from "./home";

afterEach(() => vi.restoreAllMocks());

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
    expect(items.map((i) => i.segment)).toEqual(["settings", "settings", "calendar", "inbox?filter=important", "inbox"]);
  });

  it("shows nothing for healthy feeds, no meetings ahead, zero counts or no priority list", () => {
    expect(toAttention({ connections: [{ provider: "google", status: "active" }], meetings: meetings.slice(0, 2), mail: { unread_important: 0, unread_priority: 4, priority_configured: false }, now })).toEqual([]);
    expect(toAttention({ connections: [], meetings: [], mail: null, now })).toEqual([]);
  });

  it("a meeting in progress is shown as on now", () => {
    const later = new Date("2026-11-06T14:40:00Z");
    expect(toAttention({ connections: [], meetings, mail: null, now: later }).map((i) => i.label)).toEqual(["Now: Leadership sync until 10:00 AM"]);
  });

  it("two problem connections of the same provider get distinct keys", () => {
    const items = toAttention({ connections: [{ id: "a", provider: "google", status: "degraded" }, { id: "b", provider: "google", status: "reconnect_required" }], meetings: [], mail: null, now });
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });
});

describe("loadHome / homeFor", () => {
  type Result = { data: unknown; error: unknown };
  const ok = (data: unknown): Result => ({ data, error: null });
  const fakeClient = (r: { conns: Result; meetings: Result; mail: Result; calendar?: Result; upcoming?: Result }, calls: unknown[] = []) => ({
    schema: () => ({
      from: () => ({ select: () => ({ eq: (_c: string, lane: string) => ({ eq: (col: string, v: string) => (calls.push(["connections", lane]), calls.push(["connections", `${col}=${v}`]), Promise.resolve(r.conns)) }) }) }),
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push([fn, args]);
        const later = fn === "home_meetings" && args.p_from !== "2026-11-06T05:00:00.000Z";
        const res = later && r.upcoming ? r.upcoming : { home_meetings: r.meetings, home_mail_attention: r.mail, home_calendar_status: r.calendar ?? ok("connected") }[fn];
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
    expect(view).toEqual({ calendar: "connected", meetings: [], upcoming: [], feeds: [{ provider: "google", status: "active" }], unreadImportant: 0, attention: [] });
    expect(calls).toContainEqual(["connections", "PKG"]);
    expect(calls).toContainEqual(["connections", "transport=native"]); // a Composio connection is not a feed yet (T-219)
    expect(calls).toContainEqual(["home_calendar_status", { p_lane: "PKG" }]);
    expect(calls).toContainEqual(["home_meetings", { p_lane: "PKG", p_from: "2026-11-06T05:00:00.000Z", p_to: "2026-11-07T05:00:00.000Z" }]);
    expect(calls).toContainEqual(["home_mail_attention", { p_lane: "PKG", p_since: "2026-11-05T14:00:00.000Z" }]); // last 24 h
    expect(calls).toContainEqual(["home_meetings", { p_lane: "PKG", p_from: "2026-11-07T05:00:00.000Z", p_to: "2026-11-14T05:00:00.000Z" }]); // coming up
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

  it("no counts row (no mail view, decided in SQL) means Home says nothing about mail", async () => {
    const admin = fakeClient({ conns: ok([{ provider: "google", status: "active" }]), meetings: ok([]), mail: ok([]), calendar: ok("no_access") });
    expect(await loadHome(admin as never, "PKG", now)).toMatchObject({ unreadImportant: null, attention: [] });
  });

  it("a database error becomes 'unavailable', never an empty day", async () => {
    const client = fakeClient({ conns: { data: [], error: null }, meetings: { data: null, error: { message: "x" } }, mail: { data: [], error: null } });
    const g = { requireLane: async () => ({ client }) as never };
    expect(await homeFor(g, "PKG", now)).toMatchObject({ calendar: "no_access", meetings: [], upcoming: [], attention: [], unavailable: true });
  });

  it("a failed 'coming up' read leaves today in place", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = fakeClient({ conns: ok([]), meetings: ok([meetingRow]), mail: ok([]), upcoming: { data: null, error: { message: "x" } } });
    expect(await loadHome(client as never, "PKG", now)).toMatchObject({ meetings: [{ title: "Sync" }], upcoming: [] });
  });

  it("an authorization failure from the lane gate is not swallowed", async () => {
    const g = { requireLane: async () => { throw new Error("forbidden"); } };
    await expect(homeFor(g, "PKG", now)).rejects.toThrow("forbidden");
  });
});

describe("composeBriefing", () => {
  const now = new Date("2026-11-06T14:00:00Z"); // 9:00 New York
  const m = (title: string, start: string, end: string, allDay = false): HomeMeeting => ({ title, startAt: start, endAt: end, allDay, location: null, calendarUrl: null, meetingUrl: null });
  const base = { calendar: "connected" as const, meetings: [] as HomeMeeting[], upcoming: [] as HomeMeeting[], feeds: [{ provider: "google", status: "active" }, { provider: "quickbooks", status: "active" }], unreadImportant: 5 };

  it("a clear day points at the next meeting, then mail and feeds", () => {
    const lines = composeBriefing({ ...base, upcoming: [m("Board prep", "2026-11-09T15:00:00Z", "2026-11-09T16:00:00Z")] }, now);
    expect(lines).toEqual(["No meetings today; next is Board prep on Mon, Nov 9 at 10:00 AM.", "5 unread important emails in the last 24 hours.", "Google and QuickBooks are connected."]);
  });

  it("a busy day counts what is still ahead", () => {
    const lines = composeBriefing({ ...base, unreadImportant: 1, meetings: [m("Done", "2026-11-06T13:00:00Z", "2026-11-06T13:30:00Z"), m("Sync", "2026-11-06T15:00:00Z", "2026-11-06T15:30:00Z"), m("Review", "2026-11-06T18:00:00Z", "2026-11-06T19:00:00Z")] }, now);
    expect(lines[0]).toBe("2 meetings left today; next is Sync at 10:00 AM.");
    expect(lines[1]).toBe("1 unread important email in the last 24 hours.");
  });

  it("a meeting in progress is on now, not over", () => {
    const at = new Date("2026-11-06T15:10:00Z");
    const sync = m("Sync", "2026-11-06T15:00:00Z", "2026-11-06T15:30:00Z");
    expect(composeBriefing({ ...base, meetings: [sync] }, at)[0]).toBe("1 meeting left today; Sync is on now.");
    expect(composeBriefing({ ...base, meetings: [sync, m("Review", "2026-11-06T18:00:00Z", "2026-11-06T19:00:00Z")] }, at)[0]).toBe("2 meetings left today; Sync is on now, then Review at 1:00 PM.");
  });

  it("all-day events and finished meetings point at what is coming up", () => {
    const offsite = m("Offsite", "2026-11-06T05:00:00Z", "2026-11-07T05:00:00Z", true);
    const prep = m("Board prep", "2026-11-09T15:00:00Z", "2026-11-09T16:00:00Z");
    expect(composeBriefing({ ...base, meetings: [offsite], upcoming: [prep] }, now)[0]).toBe("Only all-day events today. Next is Board prep on Mon, Nov 9 at 10:00 AM.");
    expect(composeBriefing({ ...base, meetings: [offsite, m("Done", "2026-11-06T13:00:00Z", "2026-11-06T13:30:00Z")] }, now)[0]).toBe("1 meeting today, none left.");
    expect(composeBriefing({ ...base, meetings: [offsite, m("Sync", "2026-11-06T15:00:00Z", "2026-11-06T15:30:00Z")] }, now)[0]).toBe("1 meeting left today; next is Sync at 10:00 AM.");
  });

  it("only active feeds are called connected", () => {
    const lines = composeBriefing({ ...base, feeds: [{ provider: "google", status: "active" }, { provider: "stripe", status: "pending" }] }, now);
    expect(lines[lines.length - 1]).toBe("Google is connected.");
  });

  it("names feeds that need attention instead of saying all is connected", () => {
    const lines = composeBriefing({ ...base, feeds: [{ provider: "google", status: "active" }, { provider: "quickbooks", status: "reconnect_required" }] }, now);
    expect(lines[lines.length - 1]).toBe("QuickBooks needs attention in Settings.");
  });

  it("says nothing about what the caller may not see", () => {
    expect(composeBriefing({ calendar: "no_access", meetings: [], upcoming: [], feeds: [], unreadImportant: null }, now)).toEqual([]);
  });
});

describe("homeKpis", () => {
  it("never shows a figure; each tile says why, from the visible feeds (QuickBooks figures are on their own cards, T-233)", () => {
    const tiles = homeKpis([{ provider: "quickbooks", status: "active" }, { provider: "google", status: "active" }]);
    expect(tiles.map((t) => `${t.label}: ${t.statusText}`)).toEqual(["MRR: Stripe not connected yet", "Paid subscribers: GoHighLevel not connected yet"]);
    expect(tiles.map((t) => t.connect)).toEqual([true, true]);
    expect(tiles.map((t) => t.connected)).toEqual([false, false]); // T-235 part 4: no tile on Home
  });

  it("a broken feed asks for a reconnect; a working one waits for its sync", () => {
    const tiles = homeKpis([{ provider: "quickbooks", status: "reconnect_required" }, { provider: "stripe", status: "active" }, { provider: "ghl", status: "active" }]);
    expect(tiles.map((t) => t.statusText)).toEqual(["Waiting for the Stripe sync", "Waiting for the GoHighLevel sync"]);
    expect(tiles.map((t) => t.connect)).toEqual([false, false]);
    expect(tiles.map((t) => t.connected)).toEqual([true, true]);
  });

  it("a role that cannot see feeds gets a neutral text", () => {
    expect(new Set(homeKpis([]).map((t) => t.statusText))).toEqual(new Set(["Not available yet"]));
    expect(homeKpis([]).map((t) => t.connect)).toEqual([false, false]); // never "Not connected · Connect" for a caller who cannot see feeds
  });
});
