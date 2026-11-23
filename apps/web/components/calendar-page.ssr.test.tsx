// T-274: the Calendar page rendered on the server (react-dom/server, as Next's SSR does) with synthetic events (rule 10): each view, each state,
// the legend, a de-duplicated event, link safety and plain-text rendering of markup in a title.
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CalendarScreen } from "./calendar-page";
import { toAccounts, toEvents, type CalendarData } from "@/lib/calendar-page";
import { periodFor, type CalendarView, type Ymd } from "@/lib/calendar-time";

const G = "00000000-0000-4000-8000-000000032701";
const M = "00000000-0000-4000-8000-000000032702";
const TODAY: Ymd = "2026-11-23";

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
  location: null,
  source_url: null,
  online_meeting_url: null,
  organizer_email: null,
  organizer_name: null,
  status: "confirmed",
  ...o,
});
const accounts = () =>
  toAccounts([
    { id: G, provider: "google", status: "active", external_account_id: "robert@example.test" },
    { id: M, provider: "microsoft", status: "active", external_account_id: "robert@ms.example.test" },
  ]);
const connected = (rows: unknown[], extra: Partial<Extract<CalendarData, { state: "connected" }>> = {}): CalendarData => ({ state: "connected", accounts: accounts(), events: toEvents(rows), truncated: false, ...extra });

async function ssr(view: CalendarView, date: Ymd, data: CalendarData): Promise<{ html: string; errors: unknown[] }> {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(<CalendarScreen laneId="PKG" today={TODAY} period={periodFor(view, date)} data={data} />, {
    onError: (e) => {
      errors.push(e);
    },
  });
  await stream.allReady;
  return { html: await new Response(stream).text(), errors };
}

const EVENTS = [
  row({ title: "Google planning", location: "Room 1", organizer_name: "Boss", organizer_email: "boss@example.test", source_url: "https://calendar.example.test/e1", online_meeting_url: "https://meet.example.test/e1" }),
  row({ connection_id: M, provider: "microsoft", event_id: "m1", title: "Outlook review", start_at: "2026-11-24T15:00:00Z", end_at: "2026-11-24T16:00:00Z", source_url: "https://outlook.example.test/m1" }),
  row({ event_id: "ad1", title: "Offsite", all_day: true, start_date: "2026-11-23", end_date: "2026-11-25", start_at: "2026-11-23T05:00:00Z", end_at: "2026-11-25T05:00:00Z" }),
];

describe("Calendar page, server-side render", () => {
  it("Week: header, Eastern Time line, view switch, legend, events, the all-day row and today", async () => {
    const { html, errors } = await ssr("week", TODAY, connected(EVENTS));
    expect(errors).toEqual([]);
    expect(html).toContain("Nov 22 – 28, 2026");
    expect(html).toContain("Times are Eastern Time");
    for (const l of ["Today", "Day", "Week", "Month"]) expect(html).toContain(l);
    expect(html).toContain('href="/PKG/calendar?view=week&amp;date=2026-11-16"'); // previous week
    expect(html).toContain('href="/PKG/calendar?view=week&amp;date=2026-11-30"'); // next week
    expect(html).toContain('href="/PKG/calendar?view=month&amp;date=2026-11-23"');
    expect(html).toContain('aria-current="page"'); // the current view
    expect(html).toContain('aria-current="date"'); // today
    expect(html).toContain("Google planning");
    expect(html).toContain("Outlook review");
    expect(html).toContain("Offsite");
    expect(html).toContain("Google Calendar · robert@example.test");
    expect(html).toContain("Outlook · robert@ms.example.test");
    expect(html).toContain('data-testid="calendar-week-list"'); // the phone list
    expect(html).toContain("Open in Google Calendar");
    expect(html).toContain("Open in Outlook");
    expect(html).toContain("Join");
    expect(html).toContain("Organizer: Boss (boss@example.test)");
    expect(html).toContain("Place: Room 1");
  });

  it("one colour per account: each event uses its connection's colour, and the legend shows both", async () => {
    const { html } = await ssr("day", TODAY, connected([row({ title: "Only google" }), row({ connection_id: M, provider: "microsoft", event_id: "m1", title: "Only outlook", start_at: "2026-11-23T18:00:00Z", end_at: "2026-11-23T19:00:00Z" })]));
    expect(html).toMatch(/border-l-chart-1[^>]*>[\s\S]{0,200}Only google/);
    expect(html).toMatch(/border-l-chart-2[^>]*>[\s\S]{0,200}Only outlook/);
    expect(html).toContain("bg-chart-1");
    expect(html).toContain("bg-chart-2");
  });

  it("Day: the hour grid places overlapping events side by side and shows the all-day row", async () => {
    const { html } = await ssr("day", TODAY, connected([row({ title: "First" }), row({ event_id: "e2", title: "Second", start_at: "2026-11-23T15:30:00Z", end_at: "2026-11-23T16:30:00Z" }), EVENTS[2]]));
    expect(html).toContain("Monday, November 23, 2026");
    expect(html).toContain('data-testid="calendar-allday"');
    expect(html).toContain("Offsite");
    expect(html).toContain("width:50.000%");
    expect(html).toContain("left:50.000%");
    expect(html).not.toContain('data-testid="calendar-week-list"');
    expect(html).toContain("8 AM");
  });

  it("Month: up to three events a day, then +N more linking to that day's Day view", async () => {
    const many = Array.from({ length: 5 }, (_, i) => row({ event_id: `e${String(i)}`, title: `Meeting ${String(i)}`, start_at: `2026-11-23T${String(14 + i)}:00:00Z`, end_at: `2026-11-23T${String(14 + i)}:30:00Z` }));
    const { html } = await ssr("month", TODAY, connected(many));
    expect(html).toContain("November 2026");
    expect(html).toContain("Meeting 0");
    expect(html).toContain("Meeting 2");
    expect(html).not.toContain("Meeting 3");
    expect(html).toContain("+2 more");
    expect(html).toContain('href="/PKG/calendar?view=day&amp;date=2026-11-23"');
    expect(html).toContain('href="/PKG/calendar?view=month&amp;date=2026-12-01"');
  });

  it("a de-duplicated event is one event with its winning account", async () => {
    const dup = row({ connection_id: M, provider: "microsoft", connection_ids: [G, M], event_id: "dup", title: "Shared meeting", source_url: "https://outlook.example.test/dup" });
    const { html } = await ssr("day", TODAY, connected([dup]));
    expect(html.match(/Shared meeting/g)?.length).toBe(2); // the chip and its panel, not two events
    expect(html.match(/data-testid="event"/g)?.length).toBe(1);
    expect(html).toContain("Accounts: Outlook · robert@ms.example.test, Google Calendar · robert@example.test"); // the winner first
    expect(html).toMatch(/border-l-chart-2/); // the winning connection's colour
    const single = await ssr("day", TODAY, connected([row({ title: "Solo" })]));
    expect(single.html).toContain("Account: Google Calendar · robert@example.test");
    expect(single.html).not.toContain("Accounts:");
  });

  it("the grids do not clip the details panel; late events and last-row month events open upward; every event shares one exclusive group", async () => {
    const late = row({ title: "Late one", start_at: "2026-11-23T23:00:00Z", end_at: "2026-11-24T00:00:00Z" }); // 6 PM Eastern: lower half of 8 AM to 8 PM
    const early = row({ event_id: "e2", title: "Early one", start_at: "2026-11-23T14:00:00Z", end_at: "2026-11-23T14:30:00Z" });
    const { html } = await ssr("day", TODAY, connected([late, early]));
    const grid = html.match(/<div data-testid="calendar-grid" class="([^"]*)"/)?.[1] ?? "";
    expect(grid).not.toContain("overflow-hidden");
    const after = (h: string, t: string) => h.slice(h.indexOf(t), h.indexOf(t) + 1500);
    expect(after(html, "Late one")).toContain("bottom-full");
    expect(after(html, "Early one")).toContain("top-full");
    expect(html.match(/<details[^>]*name="calendar-event"/g)?.length).toBe(2);
    const month = await ssr("month", TODAY, connected([row({ title: "Last row", start_at: "2026-12-03T15:00:00Z", end_at: "2026-12-03T16:00:00Z" }), row({ event_id: "e3", title: "First row", start_at: "2026-11-03T15:00:00Z", end_at: "2026-11-03T16:00:00Z" })]));
    expect(month.html).not.toMatch(/data-testid="calendar-month" class="[^"]*overflow-hidden/);
    expect(after(month.html, "Last row")).toContain("bottom-full");
    expect(after(month.html, "First row")).toContain("top-full");
    expect(month.html).toContain('name="calendar-event"');
  });

  it("Previous and Next are disabled at the two-year limit", async () => {
    const edge = "2028-11-23"; // today (2026-11-23) + 731 days
    const { html } = await ssr("day", edge, connected([]));
    expect(html).toMatch(/aria-disabled="true"[^>]*aria-label="Next day"|aria-label="Next day"[^>]*aria-disabled="true"/);
    expect(html).not.toContain('href="/PKG/calendar?view=day&amp;date=2028-11-24"');
    expect(html).toContain('href="/PKG/calendar?view=day&amp;date=2028-11-22"');
    const mid = await ssr("day", TODAY, connected([]));
    expect(mid.html).not.toContain('aria-disabled="true"');
  });

  it("an all-day event spans its days, the end date being exclusive", async () => {
    const { html } = await ssr("week", TODAY, connected([EVENTS[2]]));
    const cells = (html.match(/data-testid="event"/g) ?? []).length;
    expect(cells).toBe(4); // two days, in the grid's all-day row and in the phone list
  });

  it("tentative events look lighter and are named as tentative", async () => {
    const { html } = await ssr("day", TODAY, connected([row({ status: "tentative", title: "Maybe" })]));
    expect(html).toContain("opacity-70");
    expect(html).toContain("(tentative)");
  });

  it("shows only https links, opened in a new tab without a referrer or opener", async () => {
    const bad = row({ title: "Links", source_url: "javascript:alert(1)", online_meeting_url: "http://meet.example.test/x" });
    const { html } = await ssr("day", TODAY, connected([bad]));
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("http://meet.example.test");
    expect(html).not.toContain("Open in Google Calendar");
    expect(html).not.toContain("Join");
    const good = await ssr("day", TODAY, connected([row({ source_url: "https://calendar.example.test/x", online_meeting_url: "https://meet.example.test/x" })]));
    expect(good.html).toContain('href="https://meet.example.test/x" target="_blank" rel="noopener noreferrer"');
    expect(good.html).toContain('href="https://calendar.example.test/x" target="_blank" rel="noopener noreferrer"');
  });

  it("renders markup in a title, place and organizer as text", async () => {
    const evil = row({ title: '<img src=x onerror="alert(1)">', location: "<script>alert(2)</script>", organizer_name: "<b>Boss</b>" });
    const { html, errors } = await ssr("day", TODAY, connected([evil]));
    expect(errors).toEqual([]);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b>Boss");
  });

  it("names an account that needs reconnecting, with a link to Settings", async () => {
    const data = connected([], { accounts: toAccounts([{ id: M, provider: "microsoft", status: "reconnect_required", external_account_id: "robert@ms.example.test" }]) });
    const { html } = await ssr("week", TODAY, data);
    expect(html).toContain("Outlook · robert@ms.example.test");
    expect(html).toContain("Needs reconnecting");
    expect(html).toContain('href="/PKG/settings"');
  });

  it("states: not connected, no access, could not load (never an empty calendar), more events than shown", async () => {
    const nc = await ssr("week", TODAY, { state: "not_connected" });
    expect(nc.html).toContain("No calendar connected");
    expect(nc.html).toContain('href="/PKG/settings"');
    expect(nc.html).not.toContain('data-testid="calendar-grid"');
    const na = await ssr("week", TODAY, { state: "no_access" });
    expect(na.html).toContain("No access to the calendar");
    const un = await ssr("month", TODAY, { state: "unavailable" });
    expect(un.html).toContain("Could not load the calendar");
    expect(un.html).not.toContain("No events in this period");
    expect(un.html).not.toContain('data-testid="calendar-month"');
    const tr = await ssr("week", TODAY, connected([row()], { truncated: true }));
    expect(tr.html).toContain("more events than are shown");
    const none = await ssr("week", TODAY, connected([]));
    expect(none.html).toContain("No events in this period");
  });

  it("renders both daylight-saving days without error", async () => {
    for (const [view, date] of [["day", "2026-03-08"], ["week", "2026-03-08"], ["day", "2026-11-01"], ["month", "2026-11-01"]] as const) {
      const { html, errors } = await ssr(view, date, connected([row({ start_at: `${date}T15:00:00Z`, end_at: `${date}T16:00:00Z`, title: "On the change day" })]));
      expect(errors).toEqual([]);
      expect(html).toContain("On the change day");
    }
  });
});
