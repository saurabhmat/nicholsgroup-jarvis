// @vitest-environment jsdom
// T-231a: Coverage (now in Settings -> Connections, T-234) shows each stream with a fixed reason; Today's calendar shows flags and
// Join, never declined events; times are in the viewer's zone with the event's zone added when it differs.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { analyzeDay, notableAhead, parseEvents, toCoverage, parseCoverageRows } from "@nichols/briefing/domain";
import { AttentionSection, LookAhead, TodayCalendar } from "./home-briefing";
import { CoverageList } from "./coverage-list";

afterEach(cleanup);
const now = new Date("2026-11-12T13:00:00Z");
const owners = new Set(["me@pubk.test"]);
const internal = new Set(["pubk.test"]);

describe("CoverageList (Settings -> Connections)", () => {
  it("lists every stream with its last sync, state and fixed reason", () => {
    const items = toCoverage(
      parseCoverageRows([
        { stream: "mail", account: "me@pubk.test", connection_id: "c", provider: "google", status: "active", configured: true, last_sync_at: "2026-11-12T12:55:00Z" },
        { stream: "calendar", account: "me@pubk.test", connection_id: "c", provider: "google", status: "reconnect_required", configured: true, last_sync_at: "2026-11-12T08:00:00Z", error_kind: "reconnect_required" },
        { stream: "mail", account: "ceo@pubk.test", connection_id: null, provider: null, status: "not_connected", configured: true, last_sync_at: null },
      ]),
      now,
      120,
    );
    render(<CoverageList view={{ items, unavailable: false }} tz="America/New_York" now={now} />);
    const rows = screen.getAllByTestId("coverage-item");
    expect(rows.map((i) => i.getAttribute("data-state"))).toEqual(["ok", "error", "not_connected"]);
    expect(within(rows[0] as HTMLElement).getByText("Synced 7:55 AM (5 min ago)")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Access expired. Reconnect in Settings.")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Error")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Never synced")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Not connected. Connect it in Settings.")).toBeTruthy();
  });

  it("an outage says so instead of an empty list", () => {
    render(<CoverageList view={{ items: [], unavailable: true }} tz="America/New_York" now={now} />);
    expect(screen.getByTestId("coverage-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("coverage-item")).toBeNull();
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

describe("AttentionSection", () => {
  const thread = {
    connectionId: "c1", threadKey: "t1", messageId: "m1", fromAddress: "boss@pubk.test", fromName: "Boss", subject: "Board deck", receivedAt: "2026-11-12T12:00:00Z",
    sourceUrl: "https://mail.google.com/mail/u/me/#all/t1", labels: ["INBOX"], isImportant: false, lastIsOwner: false, ownerReplied: false, unreadCount: 1, inboundCount: 1,
  };
  it("shows subject, reason, source (mailbox, sender, date) and a thread link", () => {
    render(<AttentionSection tz="America/New_York" mail={{ access: true, attention: [{ key: "k", kind: "priority", reason: "Priority sender, unread · 1h", thread }], more: 2, money: [], mailboxOf: { c1: "me@pubk.test" } }} />);
    const item = screen.getByTestId("attention-item");
    expect(within(item).getByText("Board deck")).toBeTruthy();
    expect(within(item).getByText("Priority sender, unread · 1h")).toBeTruthy();
    expect(within(item).getByText("me@pubk.test · Boss <boss@pubk.test> · Thu, Nov 12, 7:00 AM")).toBeTruthy();
    expect(within(item).getByRole("link", { name: "Open thread" }).getAttribute("href")).toBe(thread.sourceUrl);
    expect(screen.getByText("2 more in the Inbox.")).toBeTruthy();
  });
  it("says why there is no mail instead of 'nothing'", () => {
    render(<AttentionSection tz="America/New_York" mail={{ access: false, unavailable: true }} />);
    expect(screen.getByText("Mail could not be read")).toBeTruthy();
  });
});
