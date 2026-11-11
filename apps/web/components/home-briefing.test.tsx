// @vitest-environment jsdom
// T-231a: the Coverage strip always shows a line and each stream with a fixed reason; Today's calendar shows flags and
// Join, never declined events; times are in the viewer's zone with the event's zone added when it differs.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { analyzeDay, notableAhead, parseEvents, toCoverage, parseCoverageRows, coverageLine } from "@nichols/briefing/domain";
import { CoverageStrip, LookAhead, TodayCalendar } from "./home-briefing";
import type { BriefingView } from "@/lib/briefing";

afterEach(cleanup);
const now = new Date("2026-11-12T13:00:00Z");
const owners = new Set(["me@pubk.test"]);
const internal = new Set(["pubk.test"]);

describe("CoverageStrip", () => {
  it("lists every stream with its state and reason, and links to Settings", () => {
    const coverage = toCoverage(
      parseCoverageRows([
        { stream: "mail", account: "me@pubk.test", connection_id: "c", provider: "google", status: "active", configured: true, last_sync_at: "2026-11-12T12:55:00Z" },
        { stream: "mail", account: "ceo@pubk.test", connection_id: null, provider: null, status: "not_connected", configured: true, last_sync_at: null },
      ]),
      now,
      120,
    );
    const view = { viewerTz: "America/New_York", coverage, coverageLine: coverageLine(coverage, true), calendar: { access: false }, config: {}, mailboxes: [] } as unknown as BriefingView;
    render(<CoverageStrip laneId="PKG" view={view} now={now} />);
    const items = screen.getAllByTestId("coverage-item");
    expect(items.map((i) => i.getAttribute("data-state"))).toEqual(["ok", "not_connected"]);
    expect(within(items[1] as HTMLElement).getByText("Not connected. Connect it in Settings.")).toBeTruthy();
    expect(screen.getByTestId("coverage-line").textContent).toMatch(/ceo@pubk\.test: not connected/);
    expect(screen.getByRole("link", { name: "Connections in Settings" }).getAttribute("href")).toBe("/PKG/settings#connections");
  });
});

describe("TodayCalendar", () => {
  it("shows flags, the other zone, Join; hides declined", () => {
    const events = parseEvents([
      {
        calendar_id: "primary", event_id: "a", title: "Board prep", start_at: "2026-11-12T14:00:00Z", end_at: "2026-11-12T15:00:00Z", timezone: "America/Los_Angeles",
        online_meeting_url: "https://meet.example.test/a", attendees: [{ email: "me@pubk.test", response: "needs_action" }, { email: "guest@acme.test", name: "Guest" }],
      },
      { calendar_id: "primary", event_id: "b", title: "Overlap", start_at: "2026-11-12T14:30:00Z", end_at: "2026-11-12T15:30:00Z", attendees: [] },
      { calendar_id: "primary", event_id: "c", title: "Said no", start_at: "2026-11-12T18:00:00Z", end_at: "2026-11-12T19:00:00Z", attendees: [{ email: "me@pubk.test", response: "declined" }] },
    ]);
    render(<TodayCalendar calendar={{ access: true, today: analyzeDay(events, owners, internal), ahead: [], owners: [...owners] }} tz="America/New_York" now={now} />);
    const rows = screen.getAllByTestId("calendar-event");
    expect(rows).toHaveLength(2);
    expect(screen.queryByText("Said no")).toBeNull();
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText("9:00 AM (6:00 AM PST) – 10:00 AM")).toBeTruthy();
    expect(first.getByText("Clashes with Overlap")).toBeTruthy();
    expect(first.getByText("RSVP pending")).toBeTruthy();
    expect(first.getByText("External")).toBeTruthy();
    expect(first.getByText("With Guest")).toBeTruthy();
    expect(first.getByRole("link", { name: "Join" }).getAttribute("href")).toBe("https://meet.example.test/a");
  });

  it("says why there is no calendar instead of showing an empty day", () => {
    render(<TodayCalendar calendar={{ access: false }} tz="America/New_York" now={now} />);
    expect(screen.getByText("No calendar to show")).toBeTruthy();
  });
});

describe("LookAhead", () => {
  it("lists notable events with the reason", () => {
    const ahead = notableAhead(parseEvents([{ calendar_id: "primary", event_id: "x", title: "Client call", start_at: "2026-11-14T15:00:00Z", end_at: "2026-11-14T16:00:00Z", attendees: [{ email: "c@acme.test" }] }]), owners, internal);
    render(<LookAhead events={ahead} tz="America/New_York" />);
    expect(screen.getByText("External: c@acme.test")).toBeTruthy();
    expect(screen.getByText(/Sat, Nov 14/)).toBeTruthy();
  });
});
