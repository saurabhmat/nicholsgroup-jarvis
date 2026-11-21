// @vitest-environment jsdom
// T-260, T-261: UI text per provider. Home's attention list, Today, the 7-day look-ahead and Settings' Coverage for a person with a Google and a Microsoft
// mailbox/calendar: each row names its provider and account, links "Open in Gmail" / "Open in Outlook" / "Open in Google Calendar" from the row's own link, Join links are
// shown and never opened, Reply is a fixed note for a Microsoft row; and a Google-only person's screens carry none of it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { analyzeDay, notableAhead, parseEvents, toCoverage, parseCoverageRows } from "@nichols/briefing/domain";
import { AttentionSection, LookAhead, TodayCalendar } from "./home-briefing";
import { CoverageList } from "./coverage-list";
import { REPLY_NOT_AVAILABLE_YET } from "@/lib/reply-messages";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
afterEach(cleanup);

const now = new Date("2026-11-20T15:00:00Z");
const G = "c-google";
const M = "c-microsoft";
const sourceOf = { [G]: { provider: "google", account: "robert@pubk.example.test" }, [M]: { provider: "microsoft", account: "robert@pubkgroup.example.test" } };
const GMAIL = "https://mail.google.com/mail/?authuser=robert%40pubk.example.test#all/t1";
const OUTLOOK = "https://outlook.office365.com/owa/?ItemID=ms-1&exvsurl=1&viewmodel=ReadMessageItem";

const base = { threadKey: "t1", fromAddress: "dana@acme.example.test", fromName: "Dana Whitfield", subject: "Board deck", receivedAt: "2026-11-20T14:00:00Z", labels: ["INBOX"], isImportant: false, lastIsOwner: false, ownerReplied: false, unreadCount: 1, inboundCount: 1 };
const item = (connectionId: string, messageId: string, sourceUrl: string | null) => ({ key: `${connectionId}:${messageId}`, kind: "priority" as const, reason: "Priority sender, unread", flags: { vip: true, money: null as "invoice" | null, deadline: false, waitingOnYou: false }, thread: { ...base, connectionId, messageId, sourceUrl }, replyable: true });
const mail = (items: ReturnType<typeof item>[], extra: Record<string, unknown> = {}) => ({ access: true as const, attention: items, more: 0, stillWaiting: [] as never[], money: [], mailboxOf: { [G]: "robert@pubk.example.test", [M]: "robert@pubkgroup.example.test" }, ...extra });

describe("Home attention rows with both providers (T-260)", () => {
  it("each row names its provider and account and links 'Open in Gmail' / 'Open in Outlook' from its own link; Open still goes to Jarvis", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={mail([item(G, "g-1", GMAIL), item(M, "ms-1", OUTLOOK)], { sourceOf })} canReply />);
    const rows = screen.getAllByTestId("attention-item");
    expect(rows).toHaveLength(2);
    const [g, o] = rows as [HTMLElement, HTMLElement];
    expect(within(g).getByTestId("attention-source-label").textContent).toBe("Gmail · robert@pubk.example.test");
    expect(within(o).getByTestId("attention-source-label").textContent).toBe("Outlook · robert@pubkgroup.example.test");
    const gl = within(g).getByTestId("attention-open-in");
    expect([gl.textContent, gl.getAttribute("href"), gl.getAttribute("rel"), gl.getAttribute("target")]).toEqual(["Open in Gmail", GMAIL, "noopener noreferrer", "_blank"]);
    const ol = within(o).getByTestId("attention-open-in");
    expect([ol.textContent, ol.getAttribute("href")]).toEqual(["Open in Outlook", OUTLOOK]);
    expect(within(g).getByTestId("attention-open").getAttribute("href")).toBe("/PKG/inbox/g-1");
    expect(within(o).getByTestId("attention-open").getAttribute("href")).toBe("/PKG/inbox/ms-1");
    expect(within(g).queryByTestId("attention-mailbox")).toBeNull(); // not repeated as "to <mailbox>"
  });

  it("a Microsoft row has no Reply button (a fixed note instead, never an error); the Google row beside it keeps Reply", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={mail([item(G, "g-1", GMAIL), item(M, "ms-1", OUTLOOK)], { sourceOf })} canReply />);
    const [g, o] = screen.getAllByTestId("attention-item") as [HTMLElement, HTMLElement];
    expect(within(g).getByTestId("attention-reply")).toBeTruthy();
    expect(within(o).queryByTestId("attention-reply")).toBeNull();
    expect(within(o).getByTestId("attention-reply-unavailable").textContent).toBe(REPLY_NOT_AVAILABLE_YET);
  });

  it("a row whose link is missing still shows its label; one whose connection is not in the labels shows none", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={mail([item(M, "ms-1", null), item("c-unknown", "x-1", OUTLOOK)], { sourceOf })} />);
    const [a, b] = screen.getAllByTestId("attention-item") as [HTMLElement, HTMLElement];
    expect(within(a).getByTestId("attention-source-label").textContent).toContain("Outlook");
    expect(within(a).queryByTestId("attention-open-in")).toBeNull();
    expect(within(b).queryByTestId("attention-source")).toBeNull();
  });

  it("a Google-only person: no provider line, no 'Open in' link, Reply unchanged, and 'to <mailbox>' only with several mailboxes (as before)", () => {
    render(<AttentionSection laneId="PKG" now={now} mail={mail([item(G, "g-1", GMAIL)], { mailboxOf: { [G]: "robert@pubk.example.test" } })} canReply />);
    expect(screen.queryByTestId("attention-source")).toBeNull();
    expect(screen.queryByTestId("attention-open-in")).toBeNull();
    expect(screen.queryByTestId("attention-reply-unavailable")).toBeNull();
    expect(screen.getByTestId("attention-reply")).toBeTruthy();
    cleanup();
    render(<AttentionSection laneId="PKG" now={now} mail={mail([item(G, "g-1", GMAIL)], { mailboxOf: { [G]: "robert@pubk.example.test", c2: "ceo@pubk.example.test" } })} />);
    expect(screen.getByTestId("attention-mailbox").textContent).toBe("to robert@pubk.example.test");
  });
});

describe("Today and the look-ahead with both calendars (T-261)", () => {
  const OCAL = "https://outlook.office365.com/owa/?itemid=synthetic-m&exvsurl=1&path=/calendar/item";
  const GCAL = "https://www.google.com/calendar/event?eid=synthetic-g";
  const TEAMS = "https://teams.microsoft.com/l/meetup-join/synthetic";
  const owners = new Set(["robert@pubk.example.test", "robert@pubkgroup.example.test"]);
  const events = parseEvents([
    { connection_id: G, calendar_id: "primary", event_id: "g", title: "Google morning sync", start_at: "2026-11-20T16:00:00Z", end_at: "2026-11-20T17:00:00Z", source_url: GCAL, attendees: [] },
    { connection_id: M, calendar_id: "AAMk=", event_id: "m", title: "Microsoft afternoon call", start_at: "2026-11-20T19:00:00Z", end_at: "2026-11-20T20:00:00Z", source_url: OCAL, online_meeting_url: TEAMS, attendees: [] },
    { connection_id: M, calendar_id: "AAMk=", event_id: "h", title: "Synthetic holiday", all_day: true, start_date: "2026-11-20", end_date: "2026-11-21", start_at: "2026-11-20T05:00:00Z", end_at: "2026-11-21T05:00:00Z", source_url: OCAL, attendees: [] },
  ]);
  const calendar = (withSources: boolean) => ({ access: true as const, today: analyzeDay(events, owners, new Set()), ahead: [], owners: [...owners], ...(withSources ? { sourceOf } : {}) });

  it("each event names its calendar's provider and account, 'Open in Google Calendar' / 'Open in Outlook' from its own link; Join is shown and nothing opens it", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<TodayCalendar calendar={calendar(true)} tz="America/New_York" now={now} />);
    const rows = Object.fromEntries(screen.getAllByTestId("calendar-event").map((r) => [within(r).getAllByRole("link")[0]?.textContent ?? "", r]));
    const g = rows["Google morning sync"];
    const m = rows["Microsoft afternoon call"];
    const h = rows["Synthetic holiday"];
    if (!g || !m || !h) throw new Error("rows missing");
    expect(within(g).getByTestId("event-source-label").textContent).toBe("Google Calendar · robert@pubk.example.test");
    expect(within(g).getByTestId("event-open-in").textContent).toBe("Open in Google Calendar");
    expect(within(g).getByTestId("event-open-in").getAttribute("href")).toBe(GCAL);
    expect(within(m).getByTestId("event-source-label").textContent).toBe("Outlook · robert@pubkgroup.example.test");
    expect(within(m).getByTestId("event-open-in").textContent).toBe("Open in Outlook");
    expect(within(m).getByTestId("event-open-in").getAttribute("href")).toBe(OCAL);
    const join = within(m).getByRole("link", { name: /Join Microsoft afternoon call/ });
    expect(join.getAttribute("href")).toBe(TEAMS);
    expect(join.getAttribute("target")).toBe("_blank");
    expect(within(h).getByText("All day")).toBeTruthy();
    expect(within(h).getByTestId("event-source-label").textContent).toContain("Outlook");
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("the look-ahead names the provider and account too", () => {
    const ahead = notableAhead(
      parseEvents([{ connection_id: M, calendar_id: "AAMk=", event_id: "x", title: "External review", start_at: "2026-11-24T15:00:00Z", end_at: "2026-11-24T16:00:00Z", source_url: OCAL, attendees: [{ email: "guest@other.example.test", response: "needs_action" }, { email: "robert@pubkgroup.example.test", response: "needs_action" }] }]),
      owners, new Set(["pubkgroup.example.test"]), 8,
    );
    render(<LookAhead events={ahead} tz="America/New_York" sources={sourceOf} />);
    expect(screen.getByTestId("event-source-label").textContent).toBe("Outlook · robert@pubkgroup.example.test");
    expect(screen.getByTestId("event-open-in").getAttribute("href")).toBe(OCAL);
  });

  it("a Google-only person's Today has no provider line and no 'Open in' link (the title is still the link)", () => {
    render(<TodayCalendar calendar={calendar(false)} tz="America/New_York" now={now} />);
    expect(screen.queryByTestId("event-source")).toBeNull();
    expect(screen.queryByTestId("event-open-in")).toBeNull();
    expect(screen.getByRole("link", { name: "Google morning sync" }).getAttribute("href")).toBe(GCAL);
  });
});

describe("Coverage (Settings) lists both providers' connections of a lane together (T-260, T-261)", () => {
  const items = toCoverage(
    parseCoverageRows([
      { stream: "mail", account: "robert@pubk.example.test", connection_id: G, provider: "google", status: "active", configured: true, last_sync_at: "2026-11-20T14:55:00Z" },
      { stream: "mail", account: "robert@pubkgroup.example.test", connection_id: M, provider: "microsoft", status: "active", configured: true, last_sync_at: "2026-11-20T14:50:00Z" },
      { stream: "calendar", account: "robert@pubkgroup.example.test", connection_id: M, provider: "microsoft", status: "reconnect_required", configured: true, last_sync_at: "2026-11-19T10:00:00Z", error_kind: "reconnect_required" },
    ]),
    now,
    120,
  );
  it("names each row's provider; a Microsoft failure reads 'Microsoft access expired', a Google row is not mislabelled", () => {
    render(<CoverageList view={{ items, unavailable: false }} tz="America/New_York" now={now} />);
    const rows = screen.getAllByTestId("coverage-item");
    expect(rows.map((r) => within(r).getByTestId("coverage-provider").textContent)).toEqual([" · Gmail", " · Outlook", " · Outlook"]);
    expect(within(rows[2] as HTMLElement).getByText("Access expired. Reconnect in Settings.")).toBeTruthy();
  });
  it("a Google-only list shows no provider name (as before)", () => {
    render(<CoverageList view={{ items: items.filter((i) => i.provider === "google"), unavailable: false }} tz="America/New_York" now={now} />);
    expect(screen.queryByTestId("coverage-provider")).toBeNull();
  });
  it("the same address held by a Google and a Microsoft connection are two rows, with no duplicate-key warning", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const same = toCoverage(parseCoverageRows([
      { stream: "mail", account: "same@pubk.example.test", connection_id: G, provider: "google", status: "active", configured: true, last_sync_at: "2026-11-20T14:55:00Z" },
      { stream: "mail", account: "same@pubk.example.test", connection_id: M, provider: "microsoft", status: "active", configured: true, last_sync_at: "2026-11-20T14:55:00Z" },
    ]), now, 120);
    render(<CoverageList view={{ items: same, unavailable: false }} tz="America/New_York" now={now} />);
    expect(screen.getAllByTestId("coverage-item")).toHaveLength(2);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
