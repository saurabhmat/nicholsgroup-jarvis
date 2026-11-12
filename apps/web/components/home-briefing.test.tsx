// @vitest-environment jsdom
// T-231a: Coverage (now in Settings -> Connections, T-234) shows each stream with a fixed reason; Today's calendar shows flags and
// Join, never declined events; times are in the viewer's zone with the event's zone added when it differs.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
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
    expect(start.className).toMatch(/font-medium/);
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
    expect(first.queryByText(/^Clashes with/)).toBeNull(); // shortened visually
    expect(chips.textContent).toContain("(Clashes with Overlap)"); // sr-only detail for every chip with a title
    expect(chips.textContent).toContain("(You have not answered this invitation)");
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
    const join = within(screen.getAllByTestId("calendar-event")[0] as HTMLElement).getByRole("link", { name: "Join Board prep on meet.example.test" });
    expect(join.getAttribute("href")).toBe("https://meet.example.test/a");
    expect(join.getAttribute("rel")).toBe("noopener noreferrer");
    expect(join.getAttribute("title")).toBe("Join on meet.example.test");
    expect(join.textContent).toBe("Join");
    expect(join.className).toMatch(/h-\d|px-/); // buttonVariants size sm
    expect(screen.getAllByRole("link", { name: /^Join / })).toHaveLength(1); // the others have no (https) meeting URL
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
    expect(screen.getByText("Sat, Nov 14").tagName).toBe("TIME");
    expect(screen.getByText("10:00 AM").tagName).toBe("TIME");
    expect(screen.getByRole("link", { name: "Client call" }).getAttribute("href")).toBe("https://calendar.example.test/x");
  });
});

describe("AttentionSection (T-234 part 2, T-235 part 2: scannable rows)", () => {
  const thread = {
    connectionId: "c1", threadKey: "t1", messageId: "m1", fromAddress: "boss@www.acme.test", fromName: "Dana Whitfield", subject: "Board deck $1,200", receivedAt: "2026-11-12T10:00:00Z",
    sourceUrl: "https://mail.google.com/mail/u/me/#all/t1", labels: ["INBOX"], isImportant: false, lastIsOwner: false, ownerReplied: false, unreadCount: 1, inboundCount: 1,
  };
  const first = <T,>(l: readonly T[]): T => {
    const x = l[0];
    if (x === undefined) throw new Error("empty");
    return x;
  };
  const mail = (more = 0, mailboxOf: Record<string, string> = { c1: "me@pubk.test" }) => ({ access: true as const, attention: [{ key: "k", kind: "priority" as const, reason: "Priority sender, unread · 1h", thread }], more, money: [], mailboxOf });
  const note = { ref: "r1", what: "Deck", why: "Board meets Friday", next: "Send comments" };

  it("line 1: initials avatar (hidden from assistive tech), name, domain, age as <time> with the full date; line 2: the masked subject with a title", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={mail()} />);
    const item = screen.getByTestId("attention-item");
    const avatar = within(item).getByTestId("attention-avatar");
    expect(avatar.textContent).toBe("DW");
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
    expect(within(item).getByTestId("attention-sender").textContent).toBe("Dana Whitfield");
    expect(within(item).getByTestId("attention-sender").className).toMatch(/font-medium/);
    expect(within(item).getByTestId("attention-company").textContent).toBe(" \u00b7 acme.test"); // no www.
    const age = within(item).getByTestId("attention-age");
    expect(age.tagName).toBe("TIME");
    expect(age.getAttribute("datetime")).toBe("2026-11-12T10:00:00Z");
    expect(age.textContent).toBe("3h ago"); // "3h" visible, " ago" for screen readers
    expect(age.getAttribute("title")).toBeNull(); // a tooltip under the stretched link is never reachable
    expect(age.className).toMatch(/ml-auto/);
    const subject = within(item).getByTestId("attention-subject");
    expect(subject.textContent).toBe("Board deck [amount]");
    expect(subject.getAttribute("title")).toBeNull();
    expect(within(item).getByText(", from boss@www.acme.test").className).toMatch(/sr-only/); // the full address is reachable
    expect(subject.className).toMatch(/\btruncate\b/);
    expect(item.textContent).not.toMatch(/1,200/);
  });

  it("the company slot is the sender ADDRESS domain; an organisation in the display name never replaces it (rule 9)", () => {
    const m = mail();
    render(<AttentionSection laneId="PKG" now={now} mail={{ ...m, attention: [{ ...first(m.attention), thread: { ...thread, fromName: "CEO (nicholsgroup.com)", fromAddress: "x@evil.test" } }] }} />);
    expect(screen.getByTestId("attention-company").textContent).toBe(" \u00b7 evil.test");
    expect(screen.getByText(", from x@evil.test")).toBeTruthy();
  });

  it("a brand-new message reads 'now' (no 'now ago'); the list has role=list", () => {
    const m = mail();
    render(<AttentionSection laneId="PKG" now={now} mail={{ ...m, attention: [{ ...first(m.attention), thread: { ...thread, receivedAt: now.toISOString() } }] }} />);
    expect(screen.getByTestId("attention-age").textContent).toBe("now");
    expect(screen.getByTestId("attention-list").getAttribute("role")).toBe("list");
  });

  it("line 3 (why -> next) only when the briefing has a note, at most two lines", () => {
    const { rerender } = render(<AttentionSection laneId="PKG" now={now} mail={mail()} />);
    expect(screen.queryByTestId("attention-note")).toBeNull();
    rerender(<AttentionSection laneId="PKG" now={now} mail={mail()} notes={new Map([["c1:m1", note]])} />);
    const n = screen.getByTestId("attention-note");
    expect(n.textContent).toBe("Why it matters: Board meets Friday \u2192  Next step: Send comments");
    expect(n.className).toMatch(/line-clamp-2/);
    expect(n.className).toMatch(/text-muted-foreground/);
    expect(screen.queryByText("Deck")).toBeNull(); // "what" repeats the title
  });

  it("at most two chips, in priority order (Priority sender, Waiting on you, Unread, Security alert)", () => {
    const m = mail();
    const { rerender } = render(<AttentionSection laneId="PKG" now={now} mail={m} />);
    expect(screen.getAllByTestId("attention-chip").map((c) => c.textContent)).toEqual(["Priority sender", "Unread"]);
    rerender(<AttentionSection laneId="PKG" now={now} mail={{ ...m, attention: [{ ...first(m.attention), kind: "waiting" }] }} />);
    expect(screen.getAllByTestId("attention-chip").map((c) => c.textContent)).toEqual(["Waiting on you", "Unread"]);
    rerender(<AttentionSection laneId="PKG" now={now} mail={{ ...m, attention: [{ ...first(m.attention), kind: "security", thread: { ...thread, unreadCount: 3 } }] }} />);
    expect(screen.getAllByTestId("attention-chip").map((c) => c.textContent)).toEqual(["Unread", "Security alert"]);
    rerender(<AttentionSection laneId="PKG" now={now} mail={{ ...m, attention: [{ ...first(m.attention), kind: "waiting", thread: { ...thread, unreadCount: 0 } }] }} />);
    expect(screen.getAllByTestId("attention-chip").map((c) => c.textContent)).toEqual(["Waiting on you"]);
  });

  it("the mailbox is hidden with one mailbox and shown with several", () => {
    const { rerender } = render(<AttentionSection laneId="PKG" now={now} mail={mail()} />);
    expect(screen.queryByTestId("attention-mailbox")).toBeNull();
    expect(document.body.textContent).not.toContain("me@pubk.test");
    rerender(<AttentionSection laneId="PKG" now={now} mail={mail(0, { c1: "me@pubk.test", c2: "ceo@pubk.test" })} />);
    expect(screen.getByTestId("attention-mailbox").textContent).toBe("to me@pubk.test");
  });

  it("two connections on the same mailbox still count as one mailbox", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={mail(0, { c1: "me@pubk.test", c2: "me@pubk.test" })} />);
    expect(screen.queryByTestId("attention-mailbox")).toBeNull();
  });

  it("the footer counts the ranked items: the rows shown plus the overflow", () => {
    const { rerender } = render(<AttentionSection laneId="PKG" now={now} mail={mail()} />);
    const link = screen.getByTestId("attention-view-all");
    expect(link.textContent).toBe("View all in Inbox \u00b7 1 need attentionView all \u00b7 1 in Inbox \u2192"); // desktop and phone wording, one of them hidden by CSS
    expect(link.getAttribute("href")).toBe("/PKG/inbox");
    rerender(<AttentionSection laneId="PKG" now={now} mail={mail(30)} />);
    expect(screen.getByTestId("attention-view-all").textContent).toBe("View all in Inbox \u00b7 31 need attentionView all \u00b7 31 in Inbox \u2192");
  });

  it("T-237: the phone shows the first three rows (the rest are hidden below md); the footer has the phone wording too", () => {
    const rows = Array.from({ length: 5 }, (_, n) => ({ key: `k${String(n)}`, kind: "priority" as const, reason: "r", thread: { ...thread, messageId: `m${String(n)}`, threadKey: `t${String(n)}` } }));
    render(<AttentionSection laneId="PKG" now={now} mail={{ ...mail(0), attention: rows }} />);
    const items = screen.getAllByTestId("attention-item");
    expect(items).toHaveLength(5);
    expect(items.map((i) => /max-md:hidden/.test(i.className))).toEqual([false, false, false, true, true]);
    expect(screen.getByTestId("attention-view-all").textContent).toContain("View all \u00b7 5 in Inbox");
  });

  it("Open goes to the thread in Jarvis, never to a Google page (the old link used the stored provider URL)", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={mail()} />);
    const open = screen.getByTestId("attention-open");
    expect(open.getAttribute("href")).toBe("/PKG/inbox/m1");
    expect(open.getAttribute("target")).toBeNull();
    expect(open.textContent).toBe("Open");
    expect(open.getAttribute("aria-label")).toBe("Open: Board deck [amount]");
    for (const a of screen.getAllByRole("link")) expect(a.getAttribute("href")).not.toMatch(/google\.com/);
  });

  it("the whole row opens the thread by a stretched link: Open's ::after covers the row, Reply sits above it, and the row is not a button", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={mail()} canReply />);
    const item = screen.getByTestId("attention-item");
    expect(item.tagName).toBe("LI");
    expect(item.className).toMatch(/\brelative\b/); // the ::after's containing block
    expect(item.getAttribute("role")).toBeNull();
    expect(item.getAttribute("onclick")).toBeNull();
    const open = screen.getByTestId("attention-open");
    expect(open.className).toMatch(/after:absolute/);
    expect(open.className).toMatch(/after:-inset-x-2/);
    expect(open.className).toMatch(/focus-visible:after:outline-transparent/); // visible in forced-colors mode
    const reply = screen.getByTestId("attention-reply");
    const raised = reply.closest("span.relative");
    expect(raised?.className).toMatch(/z-\[1\]/); // above the stretched ::after, so a click on Reply never reaches Open
    expect(open.closest("span.relative")).toBeNull(); // Open itself is not raised
    // The only link to the thread that covers the row is Open; Reply is a button (no nesting of interactive elements).
    expect(within(item).getAllByRole("link")).toHaveLength(1);
    expect(item.querySelectorAll("button button, a button, button a, a a")).toHaveLength(0);
    // Hover background on desktop only.
    expect(item.className).toMatch(/\bgroup\b/);
    expect(item.firstElementChild?.className).toMatch(/md:group-hover:bg-muted/);
    expect(item.className + (item.firstElementChild?.className ?? "")).not.toMatch(/(^|\s)hover:bg/);
  });

  it("keyboard: the tab order inside a row is Reply, then Open (both natively focusable, none removed from the order)", () => {
    // jsdom has no Tab key; the tab sequence of a page is the focusable elements in DOM order.
    render(<AttentionSection laneId="PKG" now={now} mail={mail()} canReply />);
    const focusable = [...screen.getByTestId("attention-item").querySelectorAll<HTMLElement>("a[href], button, [tabindex]")];
    expect(focusable.map((e) => e.getAttribute("data-testid"))).toEqual(["attention-reply", "attention-open"]);
    for (const e of focusable) expect(e.getAttribute("tabindex")).not.toBe("-1");
    act(() => (focusable[0] as HTMLElement).focus());
    expect(document.activeElement).toBe(screen.getByTestId("attention-reply"));
    act(() => (focusable[1] as HTMLElement).focus());
    expect(document.activeElement).toBe(screen.getByTestId("attention-open"));
  });

  it("an attention row uses at most two font weights (name medium, subject regular; buttons and chips are medium)", () => {
    const m = mail();
    render(<AttentionSection laneId="PKG" now={now} mail={{ ...m, attention: [{ ...first(m.attention), kind: "priority" }] }} notes={new Map([["c1:m1", note]])} canReply />);
    const weights = new Set<string>();
    for (const el of screen.getByTestId("attention-item").querySelectorAll("[class]")) for (const w of el.getAttribute("class")?.match(/\bfont-(?:thin|light|normal|medium|semibold|bold|extrabold)\b/g) ?? []) weights.add(w);
    expect(weights.size).toBeLessThanOrEqual(2);
    expect(screen.getByTestId("attention-subject").className).not.toMatch(/font-(medium|semibold|bold)/); // regular
  });

  it("the phone row stacks (actions under the text, 44 px targets); the desktop row is one line with the actions on the right, centred", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={mail()} />);
    expect(screen.getByTestId("attention-item").firstElementChild?.className).toMatch(/flex-col/);
    expect(screen.getByTestId("attention-item").firstElementChild?.className).toMatch(/md:flex-row/);
    expect(screen.getByTestId("attention-item").firstElementChild?.className).toMatch(/md:items-center/);
    expect(screen.getByTestId("attention-item").firstElementChild?.className).toMatch(/\bpy-3\b/);
    expect(screen.getByTestId("attention-actions").className).toMatch(/max-md:\[&_a\]:min-h-11/);
    expect(screen.getByTestId("attention-actions").className).toMatch(/max-md:\[&_button\]:min-h-11/);
    expect(screen.getByTestId("attention-list").className).toMatch(/divide-y/);
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
    expect(screen.getByTestId("attention-subject").textContent).toBe("3 failure alerts from ci.test");
  });

  it("says why there is no mail instead of 'nothing'", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={{ access: false, unavailable: true }} />);
    expect(screen.getByText("Mail could not be read")).toBeTruthy();
  });
});
