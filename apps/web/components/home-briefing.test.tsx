// @vitest-environment jsdom
// T-231a: Coverage (now in Settings -> Connections, T-234) shows each stream with a fixed reason; Today's calendar shows flags and
// Join, never declined events; times are in the viewer's zone with the event's zone added when it differs.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { aheadSummaryText, analyzeDay, notableAhead, parseEvents, summarizeAhead, toCoverage, parseCoverageRows } from "@nichols/briefing/domain";
import type { BriefingView } from "@/lib/briefing";
import { AttentionSection, CalendarSections, LookAhead, TodayCalendar } from "./home-briefing";
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

describe("TodayCalendar (T-235 part 3: compact)", () => {
  const events = parseEvents([
    {
      calendar_id: "primary", event_id: "a", title: "Board prep", start_at: "2026-11-12T14:00:00Z", end_at: "2026-11-12T15:00:00Z", timezone: "America/Los_Angeles",
      online_meeting_url: "https://meet.example.test/a", source_url: "https://calendar.example.test/a",
      attendees: [
        { email: "me@pubk.test", response: "needs_action" },
        { email: "dana.whitfield@acme.test" },
        { email: "guest@acme.test", name: "Guest Person" },
        { email: "raj@acme.test", name: "raj@acme.test" },
        { email: "room1@resource.calendar.google.com", name: "Room 1" },
        { email: "ann_lee@acme.test" },
        { email: "cy@acme.test", name: "Cy Wu" },
      ],
    },
    { calendar_id: "primary", event_id: "b", title: "Overlap", start_at: "2026-11-12T14:30:00Z", end_at: "2026-11-12T15:30:00Z", attendees: [] },
    { calendar_id: "primary", event_id: "c", title: "Said no", start_at: "2026-11-12T18:00:00Z", end_at: "2026-11-12T19:00:00Z", attendees: [{ email: "me@pubk.test", response: "declined" }] },
    { calendar_id: "primary", event_id: "d", title: "Plain", start_at: "2026-11-12T20:00:00Z", end_at: "2026-11-12T21:00:00Z", online_meeting_url: "http://insecure.example.test/x", source_url: "javascript:alert(1)", attendees: [] },
  ]);
  const view = () => render(<TodayCalendar calendar={{ access: true, today: analyzeDay(events, owners, internal), ahead: [], owners: [...owners] }} tz="America/New_York" now={now} />);

  it("two columns: the start time bold in the viewer zone, the event's own zone small below; hides declined", () => {
    view();
    const rows = screen.getAllByTestId("calendar-event");
    expect(rows).toHaveLength(3);
    expect(screen.queryByText("Said no")).toBeNull();
    const first = within(rows[0] as HTMLElement);
    const start = first.getByText("9:00 AM");
    expect(start.tagName).toBe("TIME");
    expect(start.getAttribute("datetime")).toBe("2026-11-12T14:00:00.000Z");
    expect(start.className).toMatch(/font-semibold/);
    expect(first.getByTestId("event-zone").textContent).toBe("6:00 AM PST");
    expect(first.getByText("10:00 AM")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).queryByTestId("event-zone")).toBeNull(); // no own zone: nothing extra
    expect(screen.getAllByRole("list")).toHaveLength(1); // list semantics
  });

  it("attendees are names (never emails): a name, else the capitalised local part; at most 3 then '+N more'; resources and the owner left out", () => {
    view();
    const text = (screen.getAllByTestId("calendar-event")[0] as HTMLElement).textContent ?? "";
    expect(text).toContain("With Dana Whitfield, Guest Person, Raj +2 more"); // raj's 'name' is an address: local part instead
    expect(text).not.toMatch(/@/);
    expect(text).not.toContain("Room 1");
  });

  it("at most two chips, by priority (Clash, RSVP pending, then Back-to-back, External); Clash names the other event in a tooltip", () => {
    view();
    const first = within(screen.getAllByTestId("calendar-event")[0] as HTMLElement);
    const chips = first.getByTestId("event-chips");
    expect(within(chips).getByText("Clash").getAttribute("title")).toBe("Clashes with Overlap");
    expect(within(chips).getByText("RSVP pending")).toBeTruthy();
    expect(first.queryByText("External")).toBeNull(); // third by priority: dropped
    expect(chips.children).toHaveLength(2);
    expect(first.queryByText(/^Clashes with/)).toBeNull(); // shortened
  });

  it("the title links to the event (https, new tab, noopener); there is no separate 'Open in Calendar'", () => {
    view();
    const first = within(screen.getAllByTestId("calendar-event")[0] as HTMLElement);
    const link = first.getByRole("link", { name: "Board prep" });
    expect(link.getAttribute("href")).toBe("https://calendar.example.test/a");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.queryByText("Open in Calendar")).toBeNull();
    const plain = within(screen.getAllByTestId("calendar-event")[2] as HTMLElement);
    expect(plain.queryByRole("link")).toBeNull(); // javascript: and http: URLs never become links
  });

  it("Join is a small button-styled link, only with an https meeting URL", () => {
    view();
    const join = within(screen.getAllByTestId("calendar-event")[0] as HTMLElement).getByRole("link", { name: "Join" });
    expect(join.getAttribute("href")).toBe("https://meet.example.test/a");
    expect(join.getAttribute("rel")).toBe("noopener noreferrer");
    expect(join.className).toMatch(/h-\d|px-/); // buttonVariants size sm
    expect(screen.getAllByRole("link", { name: "Join" })).toHaveLength(1); // the others have no (https) meeting URL
  });

  it("says why there is no calendar instead of showing an empty day", () => {
    render(<TodayCalendar calendar={{ access: false }} tz="America/New_York" now={now} />);
    expect(screen.getByText("No calendar to show")).toBeTruthy();
  });
});

describe("Next 7 days summary and LookAhead", () => {
  const ev = (id: string, s: string, e: string, extra: Record<string, unknown> = {}) => ({ calendar_id: "primary", event_id: id, title: `E${id}`, start_at: s, end_at: e, attendees: [], ...extra });

  it("summary text: counts meetings and clashing pairs, singular and plural, none", () => {
    expect(aheadSummaryText(summarizeAhead([], owners))).toBe("No meetings");
    const one = parseEvents([ev("1", "2026-11-14T15:00:00Z", "2026-11-14T16:00:00Z")]);
    expect(aheadSummaryText(summarizeAhead(one, owners))).toBe("1 meeting");
    const many = parseEvents([
      ev("1", "2026-11-14T15:00:00Z", "2026-11-14T16:00:00Z"),
      ev("2", "2026-11-14T15:30:00Z", "2026-11-14T16:30:00Z"),
      ev("3", "2026-11-15T15:00:00Z", "2026-11-15T16:00:00Z"),
      ev("4", "2026-11-15T15:00:00Z", "2026-11-15T16:00:00Z", { all_day: true, start_date: "2026-11-15", end_date: "2026-11-16" }),
      ev("5", "2026-11-16T15:00:00Z", "2026-11-16T16:00:00Z", { attendees: [{ email: "me@pubk.test", response: "declined" }] }),
    ]);
    expect(aheadSummaryText(summarizeAhead(many, owners))).toBe("3 meetings, 1 clash");
    const two = parseEvents([ev("1", "2026-11-14T15:00:00Z", "2026-11-14T16:00:00Z"), ev("2", "2026-11-14T15:30:00Z", "2026-11-14T16:30:00Z"), ev("3", "2026-11-14T15:45:00Z", "2026-11-14T16:45:00Z")]);
    expect(aheadSummaryText(summarizeAhead(two, owners))).toBe("3 meetings, 3 clashes");
  });

  it("the header of the collapsed Next 7 days shows the summary", () => {
    const view = {
      viewerTz: "America/New_York",
      calendar: { access: true as const, today: [], ahead: [], aheadSummary: { meetings: 12, clashes: 2 }, owners: [] },
    } as unknown as BriefingView;
    render(<CalendarSections view={view} now={now} />);
    const button = screen.getByRole("button", { name: /Next 7 days/ });
    expect(button.textContent).toContain("12 meetings, 2 clashes");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("lists notable events with names (never addresses), a time column and a title link", () => {
    const ahead = notableAhead(
      parseEvents([{ calendar_id: "primary", event_id: "x", title: "Client call", start_at: "2026-11-14T15:00:00Z", end_at: "2026-11-14T16:00:00Z", source_url: "https://calendar.example.test/x", attendees: [{ email: "c.client@acme.test" }] }]),
      owners,
      internal,
    );
    render(<LookAhead events={ahead} tz="America/New_York" />);
    expect(screen.getByText("External: C Client")).toBeTruthy();
    expect(screen.getByText("Sat, Nov 14")).toBeTruthy();
    expect(screen.getByText("10:00 AM").tagName).toBe("TIME");
    expect(screen.getByRole("link", { name: "Client call" }).getAttribute("href")).toBe("https://calendar.example.test/x");
  });
});

describe("AttentionSection (T-234 part 2)", () => {
  const thread = {
    connectionId: "c1", threadKey: "t1", messageId: "m1", fromAddress: "boss@pubk.test", fromName: "Boss", subject: "Board deck $1,200", receivedAt: "2026-11-12T10:00:00Z",
    sourceUrl: "https://mail.google.com/mail/u/me/#all/t1", labels: ["INBOX"], isImportant: false, lastIsOwner: false, ownerReplied: false, unreadCount: 1, inboundCount: 1,
  };
  const mail = (more = 0) => ({ access: true as const, attention: [{ key: "k", kind: "priority" as const, reason: "Priority sender, unread · 1h", thread }], more, money: [], mailboxOf: { c1: "me@pubk.test" } });
  const note = { ref: "r1", what: "Deck", why: "Board meets Friday", next: "Send comments" };

  it("shows title (masked), AI why and next, sender, mailbox, age and a status chip", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={mail()} notes={new Map([["c1:m1", note]])} />);
    const item = screen.getByTestId("attention-item");
    expect(within(item).getByText("Board deck [amount]")).toBeTruthy();
    expect(within(item).getByText("Priority")).toBeTruthy();
    expect(within(item).getByText("Board meets Friday")).toBeTruthy();
    expect(within(item).getByText("Send comments")).toBeTruthy();
    expect(within(item).queryByText("Deck")).toBeNull(); // "what" repeats the title
    expect(within(item).getByTestId("attention-meta").textContent).toBe("Boss <boss@pubk.test> · to me@pubk.test · 3h ago");
  });

  it("Open goes to the thread in Jarvis, never to a Google page (the old link used the stored provider URL)", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={mail()} />);
    const open = screen.getByRole("link", { name: "Open" });
    expect(open.getAttribute("href")).toBe("/PKG/inbox/m1");
    expect(open.getAttribute("target")).toBeNull();
    for (const a of screen.getAllByRole("link")) expect(a.getAttribute("href")).not.toMatch(/google\.com/);
  });

  it("Reply: other roles get a link to the thread in Jarvis; the owner gets the drawer button (T-234 part 3)", () => {
    const { rerender } = render(<AttentionSection laneId="PKG" now={now} mail={mail()} />);
    expect(screen.getByTestId("attention-reply").getAttribute("href")).toBe("/PKG/inbox/m1");
    rerender(<AttentionSection laneId="PKG" now={now} mail={mail()} replies={new Map([["c1:m1", "00000000-0000-4000-8000-0000000000d1"]])} />);
    expect(screen.getByTestId("attention-reply").getAttribute("href")).toBe("/PKG/inbox/m1");
    expect(screen.getByTestId("attention-reply").getAttribute("data-has-draft")).toBe("true");
    rerender(<AttentionSection laneId="PKG" now={now} mail={mail()} canReply />);
    const reply = screen.getByTestId("attention-reply");
    expect(reply.tagName).toBe("BUTTON");
    expect(reply.getAttribute("href")).toBeNull();
    expect(reply.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("a repeated-failures item has Open but no Reply", () => {
    const m = { ...mail(), attention: [{ key: "failures:ci.test", kind: "repeated_failures" as const, reason: "3 failure alerts from ci.test", thread, count: 3 }] };
    render(<AttentionSection laneId="PKG" now={now} mail={m} />);
    expect(screen.queryByTestId("attention-reply")).toBeNull();
    expect(screen.getByTestId("attention-open")).toBeTruthy();
  });

  it("links the rest to the Inbox", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={mail(2)} />);
    expect(screen.getByRole("link", { name: "Inbox" }).getAttribute("href")).toBe("/PKG/inbox");
  });

  it("says why there is no mail instead of 'nothing'", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={{ access: false, unavailable: true }} />);
    expect(screen.getByText("Mail could not be read")).toBeTruthy();
  });
});
