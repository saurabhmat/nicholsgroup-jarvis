// @vitest-environment jsdom
// T-295 (docs/specs/messages.md 22.5 - 22.7, 22.12 tests 31, 32, 33): two accounts of one person on the Messages page. Render tests at desktop and iPhone width (labels are TEXT with the full sign-in name as
// their accessible name, a chat both accounts are in is two rows, per-account lines for an account that did not answer, "Connected accounts"), and the live behaviour (a notice of ONE account reads only that
// account's list and, if it is the open conversation's account, that conversation; "seen" is posted only for the accounts whose list was read). Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: nav.refresh, replace: vi.fn() }), usePathname: () => "/PKG/messages" }));

import { ChatListLive, MessagesLiveProvider } from "./messages-live";
import { ConversationMessages } from "./messages-client";
import { MessagesScreen } from "./messages-page";
import { resetDotForTests } from "@/lib/messages-activity-client";
import { ACTIVITY_POLL_MS } from "@/lib/messages-live-config";
import { encodeChatKey } from "@/lib/teams-chat-key";
import type { MessagesAccount, MessagesState } from "@/lib/teams-messages";
import type { ChatRowView, MessageView } from "@/lib/teams-chats";

const A = "00000000-0000-4000-8000-0000000000c1";
const B = "00000000-0000-4000-8000-0000000000c2";
const SHARED = encodeChatKey("19:shared111@thread.v2");
const ONLY_B = encodeChatKey("19:onlyb222@thread.v2");
const row = (conn: string, key: string, title: string, over: Partial<ChatRowView> = {}): ChatRowView => ({
  key, conn, account: conn === A ? "pubkgroup.com" : "pub-k.org", accountName: conn === A ? "robert@pubkgroup.com" : "robert@pub-k.org", at: "2026-11-23T14:00:00.000Z", ord: conn === A ? 0 : 1,
  title, preview: `p ${title}`, time: "9:00 AM", unread: false, external: false, ...over,
});
const WIDTHS = [1280, 375];
const at = (w: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  window.dispatchEvent(new Event("resize"));
};
const acct = (id: string, upn: string, label: string, over: Partial<MessagesAccount> = {}): MessagesAccount => ({ connectionId: id, account: upn, label, usable: true, degraded: false, missing: [], has: ["chat_read", "call_links"], ...over });
const connected = (accounts: MessagesAccount[], over: Partial<Extract<MessagesState, { kind: "connected" }>> = {}): Extract<MessagesState, { kind: "connected" }> => ({
  kind: "connected", connectionId: A, account: "robert@pubkgroup.com", degraded: false, missing: [], adminConsent: false, laneFeatures: ["chat_read", "call_links"], accounts, multi: accounts.filter((a) => a.usable).length >= 2, canAddAnother: false, ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each(WIDTHS)("two accounts at %ipx", (width) => {
  beforeEach(() => at(width));
  const hrefFor = (key: string) => key;

  it("the list: every row has its account label as text (the full sign-in name is the accessible name), a chat both accounts are in is TWO rows with their own unread marker, and each opens as its own account", () => {
    render(<ChatListLive laneId="PKG" initialRows={[row(A, SHARED, "Shared chat", { unread: false }), row(B, SHARED, "Shared chat", { unread: true }), row(B, ONLY_B, "Only B")]} moreCursor={null} selectedKey={SHARED} selectedConn={B} more={null} />);
    const rows = screen.getAllByTestId("chat-row");
    expect(rows).toHaveLength(3);
    const badges = screen.getAllByTestId("account-badge");
    expect(badges.map((b) => b.textContent)).toEqual(["pubkgroup.com", "pub-k.org", "pub-k.org"]); // text, not colour alone
    expect(screen.getAllByRole("img", { name: "Account: robert@pubkgroup.com" })).toHaveLength(1);
    expect(screen.getAllByRole("img", { name: "Account: robert@pub-k.org" })).toHaveLength(2);
    expect(rows.map((r) => r.getAttribute("data-unread"))).toEqual(["false", "true", "false"]);
    // each row's address names its own account (and the chat)
    const hrefs = rows.map((r) => r.getAttribute("href") ?? "");
    expect(hrefs[0]).toContain(`conn=${A}`);
    expect(hrefs[1]).toContain(`conn=${B}`);
    expect(hrefs[0]).toContain(`chat=${SHARED}`);
    expect(hrefs[1]).toContain(`chat=${SHARED}`);
    // only the (account, chat) PAIR that is open is current
    expect(rows.map((r) => r.getAttribute("aria-current"))).toEqual([null, "page", null]);
    // the badge truncates by CSS at 14 characters on a phone, the preview and title shrink first: nothing forces a horizontal scroll
    expect(badges[0]?.className).toMatch(/max-w-\[14ch\]/);
    expect(badges[0]?.className).toMatch(/truncate/);
    void hrefFor;
  });

  it("a one-account list looks as it always did: no label, no conn in the address", () => {
    render(<ChatListLive laneId="PKG" initialRows={[row(A, SHARED, "Chat", { account: null, accountName: null })]} moreCursor={null} selectedKey={null} more={null} />);
    expect(screen.queryByTestId("account-badge")).toBeNull();
    expect(screen.getByTestId("chat-row").getAttribute("href")).toBe(`/PKG/messages?chat=${SHARED}`);
  });

  it("an account that did not answer is one plain line: sign-in expired (with Reconnect <label> naming that connection), busy with seconds, could not be reached; and the changed-account line", () => {
    render(
      <ChatListLive
        laneId="PKG"
        initialRows={[row(B, ONLY_B, "Only B")]}
        moreCursor={null}
        selectedKey={null}
        more={null}
        initialNotes={[{ conn: A, label: "pubkgroup.com", kind: "reconnect", seconds: null }, { conn: B, label: "pub-k.org", kind: "busy", seconds: 7 }, { conn: "00000000-0000-4000-8000-0000000000c3", label: "third.test", kind: "unreachable", seconds: null }]}
        initialDropped
      />,
    );
    const lines = screen.getAllByTestId("account-note").map((l) => l.textContent);
    expect(lines[0]).toContain("pubkgroup.com: Your Teams sign-in expired.");
    expect(lines[1]).toMatch(/^pub-k\.org: Teams is busy; try again in 7 seconds\./);
    expect(lines[2]).toMatch(/^third\.test: Teams could not be reached\./);
    const reconnect = screen.getByRole("button", { name: "Reconnect pubkgroup.com" });
    expect(reconnect.closest("form")?.getAttribute("action")).toBe(`/api/connect/teams/start?lane=PKG&connection=${A}`);
    expect(screen.getAllByRole("button", { name: /^Reconnect / })).toHaveLength(1); // only the expired one has a button
    expect(screen.getByTestId("account-dropped").textContent).toBe("One of your Teams accounts changed; showing the others.");
    expect(screen.getByTestId("chat-list")).toBeTruthy(); // the other account's rows are still there: never an empty list without a reason
  });

  it("'Connected accounts': each account with its label, address and state; a feature missing on one account is said for that account only, with its own Reconnect; Connect another while under the limit", () => {
    const accounts = [acct(A, "robert@pubkgroup.com", "pubkgroup.com"), acct(B, "robert@pub-k.org", "pub-k.org", { missing: ["call_links"], has: ["chat_read"] })];
    render(<MessagesScreen laneId="PKG" state={connected(accounts, { canAddAnother: true, missing: [] })} />);
    const list = screen.getByTestId("messages-accounts");
    expect(within(list).getAllByTestId("messages-account")).toHaveLength(2);
    expect(list.textContent).toContain("robert@pubkgroup.com");
    expect(list.textContent).toContain("robert@pub-k.org");
    const problems = screen.getByTestId("messages-account-problems").textContent ?? "";
    expect(problems).toContain("pub-k.org: Reconnect Teams to add call buttons.");
    expect(problems).not.toContain("pubkgroup.com:");
    expect(screen.getByRole("button", { name: "Reconnect pub-k.org" }).closest("form")?.getAttribute("action")).toBe(`/api/connect/teams/start?lane=PKG&connection=${B}`);
    const another = within(screen.getByTestId("messages-connect-another")).getByRole("button", { name: "Connect another Teams account" });
    expect(another.closest("form")?.getAttribute("action")).toBe("/api/connect/teams/start?lane=PKG"); // a first connect: no connection id
  });

  it("an expired account beside a working one is a line for that account (the page is not 'reconnect' while one account works); at the limit there is no Connect another", () => {
    render(<MessagesScreen laneId="PKG" state={connected([acct(A, "robert@pubkgroup.com", "pubkgroup.com"), acct(B, "robert@pub-k.org", "pub-k.org", { usable: false, has: [] })])} />);
    expect(screen.getByTestId("messages-account-problems").textContent).toContain("pub-k.org: Your Teams sign-in expired.");
    expect(screen.queryByTestId("messages-connect-another")).toBeNull();
  });

  it("with one account the card is the one it always was", () => {
    render(<MessagesScreen laneId="PKG" state={connected([acct(A, "robert@pubkgroup.com", "pubkgroup.com")], { canAddAnother: false })} />);
    expect(screen.getByText("Connected as robert@pubkgroup.com")).toBeTruthy();
    expect(screen.queryByTestId("messages-accounts")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("live: a notice of ONE account (test 32)", () => {
  const calls = { urls: [] as string[], seenBodies: [] as unknown[] };
  let notices: Record<string, string | null>;
  let failConn: string | null = null;
  const msg = (id: string, at: string): MessageView => ({ id, images: null, at, time: "9:05 AM", fullTime: "x", day: at.slice(0, 10), sender: "Pat", mine: false, edited: false, deleted: false, system: false, nodes: [{ t: "text", v: id }], truncated: false, attachments: [] });
  const json = (status: number, body: unknown) => Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    calls.urls.push(`${init?.method ?? "GET"} ${u}`);
    if (u.includes("/messages/activity")) {
      if (init?.method === "POST") {
        calls.seenBodies.push(init.body === undefined ? null : JSON.parse(String(init.body)));
        return json(200, { live: true, liveUntil: null, dot: false, lastNoticeAt: null, accounts: [] });
      }
      const accounts = [A, B].map((conn) => ({ conn, live: true, liveUntil: null, dot: false, lastNoticeAt: notices[conn] ?? null }));
      return json(200, { live: true, liveUntil: null, dot: false, lastNoticeAt: accounts.map((a) => a.lastNoticeAt).filter(Boolean).sort().pop() ?? null, serverNow: new Date().toISOString(), accounts });
    }
    if (u.includes("/messages/chats")) {
      const conn = new URL(`http://x${u}`).searchParams.get("conn");
      if (conn !== null && conn === failConn) return json(503, { error: "unavailable" });
      const rows = conn === B ? [row(B, ONLY_B, "Only B new"), row(B, SHARED, "Shared chat")] : [row(A, SHARED, "Shared chat")];
      return json(200, { rows, moreCursor: null, notes: [], listed: conn === null ? [A, B] : [conn], dropped: true });
    }
    if (u.includes("/messages/newer")) return json(200, { messages: [msg("m3", "2026-11-23T14:30:00.000Z")], truncated: false });
    if (u.includes("/messages/read")) return json(204, null);
    throw new Error(`unexpected request ${u}`);
  });
  const tick = async (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const draw = async (openConn: string) => {
    render(
      <MessagesLiveProvider laneId="PKG" expectLists>
        <ChatListLive laneId="PKG" initialRows={[row(A, SHARED, "Shared chat"), row(B, SHARED, "Shared chat")]} moreCursor={null} selectedKey={SHARED} selectedConn={openConn} more={null} initialListed={[A]} />
        <ConversationMessages conn={openConn} laneId="PKG" chatKey={SHARED} initial={[msg("m1", "2026-11-23T14:00:00.000Z")]} nextBefore={null} group />
      </MessagesLiveProvider>,
    );
    await tick(0);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T15:00:00.000Z"));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Element.prototype.scrollIntoView = vi.fn();
    calls.urls = [];
    calls.seenBodies = [];
    notices = {};
    failConn = null;
    resetDotForTests();
    fetchMock.mockClear();
  });

  it("'seen' is posted only for the accounts whose list was read (the account that failed keeps its dot)", async () => {
    await draw(A);
    expect(calls.seenBodies).toEqual([{ conns: [A] }]);
  });

  it("a notice of account B re-reads ONLY B's list (`chats?conn=B`) and, B not being the open conversation's account, not the conversation; B's rows are replaced, A's stay; the answer's account is marked seen", async () => {
    await draw(A);
    calls.urls = [];
    notices[B] = "2026-11-23T15:00:20.000Z";
    await tick(ACTIVITY_POLL_MS);
    const chats = calls.urls.filter((u) => u.includes("/messages/chats"));
    expect(chats).toHaveLength(1);
    expect(chats[0]).toContain(`conn=${B}`);
    expect(calls.urls.some((u) => u.includes("/messages/newer"))).toBe(false);
    const titles = screen.getAllByTestId("chat-row").map((r) => [r.getAttribute("data-conn"), r.textContent]);
    expect(titles.filter(([c]) => c === A)).toHaveLength(1);
    expect(titles.filter(([c]) => c === B)).toHaveLength(2);
    expect(screen.queryByTestId("account-dropped")).toBeNull(); // a one-account read says nothing about the cursor's other entries
    expect(calls.seenBodies.at(-1)).toEqual({ conns: [B] });
  });

  it("a notice of the OPEN conversation's account re-reads that conversation too (with its conn); a later notice of the other account does not", async () => {
    await draw(B);
    calls.urls = [];
    notices[B] = "2026-11-23T15:00:20.000Z";
    await tick(ACTIVITY_POLL_MS);
    const newer = calls.urls.filter((u) => u.includes("/messages/newer"));
    expect(newer).toHaveLength(1);
    expect(newer[0]).toContain(`conn=${B}`);
    calls.urls = [];
    notices[A] = "2026-11-23T15:00:50.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(calls.urls.filter((u) => u.includes("/messages/chats")).every((u) => u.includes(`conn=${A}`))).toBe(true);
    expect(calls.urls.some((u) => u.includes("/messages/newer"))).toBe(false);
  });

  it("M5: when one account's re-read fails, 'seen' is posted only for the account that loaded (decided from the answers, not inside a state updater), and the page says the refresh failed", async () => {
    await draw(A);
    calls.seenBodies = [];
    failConn = A;
    notices[A] = "2026-11-23T15:00:20.000Z";
    notices[B] = "2026-11-23T15:00:20.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(calls.seenBodies).toEqual([{ conns: [B] }]);
    expect(screen.getByTestId("chat-list-refresh-failed")).toBeTruthy();
  });

  it("M3: 'Try again' on an account's line reads just that account (`chats?conn=`); a busy account is not asked before the seconds it was given; Refresh inside the first minute is not 'up to date' while a line is showing", async () => {
    render(
      <MessagesLiveProvider laneId="PKG" expectLists>
        <ChatListLive laneId="PKG" initialRows={[row(A, SHARED, "Shared chat")]} moreCursor={null} selectedKey={null} more={null} initialListed={[A]}
          initialNotes={[{ conn: B, label: "pub-k.org", kind: "busy", seconds: 7 }]} />
      </MessagesLiveProvider>,
    );
    await tick(0);
    calls.urls = [];
    const retry = screen.getByRole("button", { name: "Try again: pub-k.org" });
    await act(async () => void retry.click());
    expect(calls.urls.filter((u) => u.includes("/messages/chats"))).toEqual([]); // too early: said, not asked
    expect(screen.getByTestId("account-note-wait").textContent).toMatch(/can try again in \d+ seconds/);
    await tick(8_000);
    await act(async () => void screen.getByRole("button", { name: "Try again: pub-k.org" }).click());
    const chats = calls.urls.filter((u) => u.includes("/messages/chats"));
    expect(chats).toHaveLength(1);
    expect(chats[0]).toContain(`conn=${B}`);
    // the answer cleared the line (the fake answers with no notes)
    expect(screen.queryByTestId("account-note")).toBeNull();
  });

  it("M3: Refresh pressed inside the first minute, while an account's line is showing, reads every account at once and never says 'Already up to date'", async () => {
    render(
      <MessagesLiveProvider laneId="PKG" expectLists>
        <ChatListLive laneId="PKG" initialRows={[row(A, SHARED, "Shared chat")]} moreCursor={null} selectedKey={null} more={null} initialListed={[A]}
          initialNotes={[{ conn: B, label: "pub-k.org", kind: "unreachable", seconds: null }]} />
      </MessagesLiveProvider>,
    );
    await tick(0);
    calls.urls = [];
    await act(async () => void screen.getByTestId("chat-list-refresh").click());
    await tick(0);
    expect(calls.urls.filter((u) => u.includes("/messages/chats"))).toHaveLength(1);
    expect(screen.getByTestId("chat-list-refresh-note").textContent).toBe("");
  });

  it("the re-read of the list names the open account (`open=`) so only that account's row of a shared chat is not unread", async () => {
    await draw(A);
    calls.urls = [];
    notices[B] = "2026-11-23T15:00:20.000Z";
    await tick(ACTIVITY_POLL_MS);
    const chats = calls.urls.find((u) => u.includes("/messages/chats")) ?? "";
    expect(chats).toContain(`open=${A}`);
    expect(chats).toContain(`chat=${SHARED}`);
  });
});
