// T-274: the Calendar page's loader and row mapping, with synthetic rows (rule 10). The SQL itself is tested in pgTAP (327_calendar_events.test.sql).
import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarFor, EVENT_CAP, loadCalendar, toAccounts, toEvents, withStrays } from "./calendar-page";
import { periodFor } from "./calendar-time";

afterEach(() => vi.restoreAllMocks());

const G = "00000000-0000-4000-8000-000000032701";
const M = "00000000-0000-4000-8000-000000032702";
const row = (o: Record<string, unknown> = {}) => ({
  connection_id: G,
  provider: "google",
  connection_ids: [G],
  calendar_id: "primary",
  event_id: "e1",
  title: "Planning",
  start_at: "2026-11-23T15:00:00+00:00",
  end_at: "2026-11-23T16:00:00+00:00",
  all_day: false,
  start_date: null,
  end_date: null,
  timezone: "America/New_York",
  location: "Room 1",
  source_url: "https://calendar.example.test/e1",
  online_meeting_url: "https://meet.example.test/e1",
  organizer_email: "boss@example.test",
  organizer_name: "Boss",
  status: "confirmed",
  ...o,
});

type R = { data: unknown; error: { message: string } | null };
const fake = (r: { status?: R; conns?: R; events?: R }, calls: { rpc: [string, unknown][]; eq: [string, unknown][] } = { rpc: [], eq: [] }) => ({
  schema: () => ({
    rpc: (fn: string, args: unknown) => {
      calls.rpc.push([fn, args]);
      return Promise.resolve(fn === "home_calendar_status" ? (r.status ?? { data: "connected", error: null }) : (r.events ?? { data: [], error: null }));
    },
    from: () => {
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => {
          calls.eq.push([c, v]);
          return q;
        },
        in: () => q,
        then: (res: (v: R) => unknown) => res(r.conns ?? { data: [], error: null }),
      };
      return q;
    },
  }),
});
const period = periodFor("week", "2026-11-23");
const asDb = (x: unknown) => x as Parameters<typeof loadCalendar>[0];

describe("toEvents", () => {
  it("maps a row and keeps https links only", () => {
    const [e] = toEvents([row({ source_url: "http://calendar.example.test/x", online_meeting_url: "javascript:alert(1)" })]);
    expect(e).toMatchObject({ title: "Planning", connectionId: G, provider: "google", calendarUrl: null, meetingUrl: null, organizer: "Boss (boss@example.test)", location: "Room 1", openLabel: "Open in Google Calendar", tentative: false });
    const [ok] = toEvents([row({ provider: "microsoft", status: "tentative" })]);
    expect(ok).toMatchObject({ calendarUrl: "https://calendar.example.test/e1", meetingUrl: "https://meet.example.test/e1", openLabel: "Open in Outlook", tentative: true });
  });
  it("keeps every connection that holds a copy, the winning one first and without duplicates", () => {
    expect(toEvents([row({ connection_id: M, provider: "microsoft", connection_ids: [G, M, M, 5, ""] })])[0]?.connectionIds).toEqual([M, G]);
    expect(toEvents([row({ connection_ids: null })])[0]?.connectionIds).toEqual([G]);
  });
  it("refuses a link with credentials", () => {
    expect(toEvents([row({ online_meeting_url: "https://meet.example.test@evil.test/x" })])[0]?.meetingUrl).toBeNull();
  });
  it("fills a missing title, and drops rows with no valid time, provider, connection or all-day dates", () => {
    expect(toEvents([row({ title: "  " })])[0]?.title).toBe("(No title)");
    expect(toEvents([row({ start_at: "nope" }), row({ provider: "other" }), row({ connection_id: null }), row({ all_day: true }), row({ all_day: true, start_date: "2026-11-23", end_date: "2026-11-23" })])).toEqual([]);
    expect(toEvents(null)).toEqual([]);
  });
  it("reads an all-day event by its dates", () => {
    expect(toEvents([row({ all_day: true, start_date: "2026-11-23", end_date: "2026-11-25" })])[0]).toMatchObject({ allDay: true, startDate: "2026-11-23", endDate: "2026-11-25" });
  });
});

describe("toAccounts", () => {
  it("labels each account by provider and address, gives each its own colour, and notes the ones that need attention", () => {
    const a = toAccounts([
      { id: M, provider: "microsoft", status: "reconnect_required", external_account_id: "robert@ms.example.test" },
      { id: G, provider: "google", status: "active", external_account_id: "robert@example.test" },
      { id: "x", provider: "google", status: "disconnected", external_account_id: "old@example.test" },
      { id: "q", provider: "quickbooks", status: "active", external_account_id: "realm" },
    ]);
    expect(a.map((x) => [x.label, x.colour, x.problem])).toEqual([
      ["Google Calendar · robert@example.test", 0, null],
      ["Outlook · robert@ms.example.test", 1, "reconnect"],
    ]);
  });
  it("gives an event of an unlisted connection a label and a colour of its own", () => {
    const events = toEvents([row({ connection_id: "stray", provider: "microsoft" })]);
    const all = withStrays(toAccounts([{ id: G, provider: "google", status: "active", external_account_id: "a@example.test" }]), events);
    expect(all.map((x) => [x.id, x.colour, x.label])).toEqual([[G, 0, "Google Calendar · a@example.test"], ["stray", 1, "Outlook"]]);
  });
});

describe("loadCalendar", () => {
  it("asks for the caller's own accounts and the window, and returns the events", async () => {
    const calls = { rpc: [] as [string, unknown][], eq: [] as [string, unknown][] };
    const d = await loadCalendar(asDb(fake({ events: { data: [row()], error: null }, conns: { data: [{ id: G, provider: "google", status: "active", external_account_id: "a@example.test" }], error: null } }, calls)), "PKG", "user-1", period);
    expect(d).toMatchObject({ state: "connected", truncated: false });
    expect(calls.eq).toContainEqual(["owner_user_id", "user-1"]);
    expect(calls.eq).toContainEqual(["lane_id", "PKG"]);
    expect(calls.eq).toContainEqual(["transport", "native"]);
    expect(calls.rpc[1]).toEqual(["calendar_events", { p_lane: "PKG", p_from: period.from.toISOString(), p_to: period.to.toISOString() }]);
  });
  it("does not read events when nothing is connected or the caller has no access", async () => {
    const calls = { rpc: [] as [string, unknown][], eq: [] as [string, unknown][] };
    expect(await loadCalendar(asDb(fake({ status: { data: "not_connected", error: null } }, calls)), "PKG", "u", period)).toEqual({ state: "not_connected" });
    expect(await loadCalendar(asDb(fake({ status: { data: "no_access", error: null } }, calls)), "PKG", "u", period)).toEqual({ state: "no_access" });
    expect(await loadCalendar(asDb(fake({ status: { data: "something else", error: null } }, calls)), "PKG", "u", period)).toEqual({ state: "no_access" });
    expect(calls.rpc.map((c) => c[0])).toEqual(["home_calendar_status", "home_calendar_status", "home_calendar_status"]);
  });
  it("says there are more events than shown when the function returns one past the cap", async () => {
    const rows = Array.from({ length: EVENT_CAP + 1 }, (_, i) => row({ event_id: `e${String(i)}` }));
    const d = await loadCalendar(asDb(fake({ events: { data: rows, error: null } })), "PKG", "u", period);
    expect(d.state === "connected" && d.events.length).toBe(EVENT_CAP);
    expect(d.state === "connected" && d.truncated).toBe(true);
    const exact = await loadCalendar(asDb(fake({ events: { data: rows.slice(0, EVENT_CAP), error: null } })), "PKG", "u", period);
    expect(exact.state === "connected" && exact.truncated).toBe(false);
  });
  it("throws on a database error", async () => {
    await expect(loadCalendar(asDb(fake({ status: { data: null, error: { message: "boom" } } })), "PKG", "u", period)).rejects.toThrow("calendar data unavailable");
    await expect(loadCalendar(asDb(fake({ events: { data: null, error: { message: "boom" } } })), "PKG", "u", period)).rejects.toThrow("events");
    await expect(loadCalendar(asDb(fake({ conns: { data: null, error: { message: "boom" } } })), "PKG", "u", period)).rejects.toThrow("connections");
  });
});

describe("calendarFor", () => {
  const guard = { requireLane: () => Promise.resolve({ client: {}, session: { userId: "u" } }) } as unknown as Parameters<typeof calendarFor>[0];
  it("says unavailable on an error, never an empty calendar, and logs no row data", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d = await calendarFor(guard, "PKG", period, () => Promise.reject(new Error("secret row text")));
    expect(d).toEqual({ state: "unavailable" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret row text");
  });
  it("passes the verified user and the window to the loader", async () => {
    const load = vi.fn(() => Promise.resolve({ state: "not_connected" as const }));
    expect(await calendarFor(guard, "PKG", period, load)).toEqual({ state: "not_connected" });
    expect(load).toHaveBeenCalledWith({}, "PKG", "u", period);
  });
});
