// @vitest-environment jsdom
// T-290: the live Messages page with fake timers. The loop in the provider asks the PORTAL'S OWN database, never Microsoft; Microsoft is read again (the chat list and the open conversation) only when
// the database's `last_notice_at` MOVED (one re-read per move) or the person acted (Refresh, window focus: at most once a minute). Polling stops while the tab is hidden. fetch is faked; synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const CONN = "00000000-0000-4000-8000-0000000000c1";
const refresh = vi.hoisted(() => vi.fn());
const testAddress = vi.hoisted(() => ({ useTestSearchParams: (): URLSearchParams => { throw new Error("not set"); } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }), usePathname: () => "/PKG/messages", useSearchParams: () => testAddress.useTestSearchParams() }));

import { ConversationMessages, MessagesRefresh } from "./messages-client";
import { ChatListLive, MessagesLiveProvider } from "./messages-live";
import { MessagesScope } from "./messages-scope";
import { AddressContext, useTestSearchParams } from "../tests/support/address";
testAddress.useTestSearchParams = useTestSearchParams;
import { dotSnapshot, resetDotForTests } from "@/lib/messages-activity-client";
import { ACTIVITY_POLL_MS, REFETCH_MIN_GAP_MS } from "@/lib/messages-live-config";
import { encodeChatKey } from "@/lib/teams-chat-key";
import type { ChatRowView, MessageView } from "@/lib/teams-chats";

const KEY = encodeChatKey("19:abc123def456@thread.v2");
const msg = (id: string, at: string, over: Record<string, unknown> = {}): MessageView => ({ id, at, time: "9:05 AM", fullTime: "x", day: at.slice(0, 10), sender: "Pat", mine: false, edited: false, deleted: false, system: false, nodes: [{ t: "text", v: `text ${id}` }], truncated: false, attachments: [], ...over }) as unknown as MessageView;
const row = (key: string, title: string, unread = false): ChatRowView => ({ key, conn: CONN, account: null, accountName: null, at: null, ord: 0, title, preview: `p ${title}`, time: "9:00 AM", unread, external: false });

type Server = { truncated?: boolean; live: boolean; lastNoticeAt: string | null; dot: boolean; activityStatus: number; chats: ChatRowView[]; chatsStatus: number; chatsError?: string; newer: MessageView[]; newerStatus: number };
let server: Server;
let vis: "visible" | "hidden" = "visible";
const calls = { activity: 0, seen: 0, chats: 0, newer: 0, read: 0, urls: [] as string[] };
const json = (status: number, body: unknown) => Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  const u = String(url);
  calls.urls.push(`${init?.method ?? "GET"} ${u}`);
  if (u.includes("/messages/activity")) {
    if (init?.method === "POST") {
      calls.seen += 1;
      server.dot = false;
      return json(200, { live: server.live, liveUntil: null, dot: false, lastNoticeAt: server.lastNoticeAt });
    }
    calls.activity += 1;
    return server.activityStatus === 200 ? json(200, { live: server.live, liveUntil: null, dot: server.dot, lastNoticeAt: server.lastNoticeAt, serverNow: new Date().toISOString() }) : json(server.activityStatus, { error: "x" });
  }
  if (u.includes("/messages/chats")) {
    calls.chats += 1;
    return server.chatsStatus === 200 ? json(200, { rows: server.chats, moreCursor: null }) : json(server.chatsStatus, { error: server.chatsError ?? "busy" });
  }
  if (u.includes("/messages/newer")) {
    calls.newer += 1;
    return server.newerStatus === 200 ? json(200, { messages: server.newer, truncated: server.truncated === true }) : json(server.newerStatus, { error: "busy" });
  }
  if (u.includes("/messages/read")) {
    calls.read += 1;
    return json(204, null);
  }
  throw new Error(`unexpected request ${u}`);
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T15:00:00.000Z"));
  vi.stubGlobal("fetch", fetchMock);
  server = { live: true, lastNoticeAt: null, dot: false, activityStatus: 200, chats: [row(KEY, "Pat")], chatsStatus: 200, newer: [], newerStatus: 200 };
  vis = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => vis });
  Element.prototype.scrollIntoView = vi.fn();
  Object.assign(calls, { activity: 0, seen: 0, chats: 0, newer: 0, read: 0, urls: [] });
  resetDotForTests();
});
afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  refresh.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// T-296 review (L8): the list gets the open chat from the address through the scope, as in the page; this wrapper only turns the old props into an address
function ChatList({ selectedKey = null, selectedConn = null, ...rest }: React.ComponentProps<typeof ChatListLive> & { selectedKey?: string | null; selectedConn?: string | null }) {
  const q = selectedKey ? `${selectedConn ? `conn=${selectedConn}&` : ""}chat=${selectedKey}` : "";
  return (
    <AddressContext.Provider value={q}>
      <MessagesScope chatConns={selectedConn ? [CONN, selectedConn] : [CONN]}>
        <ChatListLive {...rest} />
      </MessagesScope>
    </AddressContext.Provider>
  );
}

const initial = [msg("m1", "2026-11-23T14:00:00.000Z"), msg("m2", "2026-11-23T14:05:00.000Z")];
function page() {
  return render(
    <MessagesLiveProvider laneId="PKG">
      <MessagesRefresh mode="live" />
      <ChatList laneId="PKG" initialRows={[row(KEY, "Pat")]} moreCursor={null} selectedKey={KEY} />
      <ConversationMessages conn={CONN} laneId="PKG" chatKey={KEY} initial={initial} nextBefore={null} group />
    </MessagesLiveProvider>,
  );
}
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const start = async () => {
  page();
  await tick(0);
};
const graphCalls = () => calls.chats + calls.newer;
const hide = async () => {
  vis = "hidden";
  await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
};
const show = async () => {
  vis = "visible";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
  });
};

describe("without working notices (no URL configured, a refused or too-short subscription)", () => {
  it("asks the database ONCE, then nothing: no loop, no dot, no seen mark, and Microsoft is never read however long the page stays open", async () => {
    server.live = false;
    await start();
    expect(calls.activity).toBe(1);
    await tick(10 * 60_000);
    expect(calls.activity).toBe(1);
    expect(calls.seen).toBe(0);
    expect(graphCalls()).toBe(0);
    expect(dotSnapshot("PKG")).toBe(false);
  });

  it("Refresh still works as a person's action (the page offers it): one re-read of the list and the conversation", async () => {
    server.live = false;
    await start();
    await tick(REFETCH_MIN_GAP_MS + 1000);
    fireEvent.click(screen.getByTestId("messages-refresh"));
    await tick(0);
    expect(calls.chats).toBe(1);
    expect(calls.newer).toBe(1);
  });
});

describe("with working notices: the loop asks OUR database, never Microsoft", () => {
  it("opening the page marks the chat list seen once and starts the loop; ten minutes of polling make 20 database asks and NO read of Microsoft without a notice or an action", async () => {
    await start();
    expect(calls.seen).toBe(1);
    expect(calls.activity).toBe(1);
    await tick(5 * 60_000);
    expect(calls.activity).toBe(1 + (5 * 60_000) / ACTIVITY_POLL_MS);
    expect(graphCalls()).toBe(0);
    expect(calls.read).toBe(0);
    // every request went to this portal's own activity route
    expect(calls.urls.every((u) => u.includes("/api/lanes/PKG/messages/activity"))).toBe(true);
  });

  it("stops asking while the tab is hidden, and asks again at once (and resumes the loop) when it is visible", async () => {
    await start();
    await tick(ACTIVITY_POLL_MS);
    const before = calls.activity;
    await hide();
    await tick(10 * 60_000);
    expect(calls.activity).toBe(before);
    await show();
    expect(calls.activity).toBe(before + 1);
    await tick(ACTIVITY_POLL_MS);
    expect(calls.activity).toBe(before + 2);
    expect(graphCalls()).toBe(0);
  });

  it("a page opened in a hidden tab asks nothing until it is shown", async () => {
    vis = "hidden";
    await start();
    await tick(5 * 60_000);
    expect(calls.activity).toBe(0);
    expect(calls.seen).toBe(0);
    await show();
    expect(calls.activity).toBe(1);
    expect(calls.seen).toBe(1);
  });

  it("a notice (last_notice_at moved) re-reads the chat list and the open conversation ONCE, the conversation with the since date range of the newest message shown; the loop's later asks with the same value read nothing", async () => {
    await start();
    server.lastNoticeAt = "2026-11-23T15:00:10.000Z";
    server.dot = true;
    server.newer = [msg("m3", "2026-11-23T14:30:00.000Z")];
    await tick(ACTIVITY_POLL_MS);
    expect(calls.chats).toBe(1);
    expect(calls.newer).toBe(1);
    expect(calls.urls.find((u) => u.includes("/messages/newer"))).toBe(`GET /api/lanes/PKG/messages/newer?conn=${CONN}&chat=${KEY}&since=${encodeURIComponent("2026-11-23T14:05:00.000Z")}`);
    expect(calls.urls.find((u) => u.includes("/messages/chats"))).toBe(`GET /api/lanes/PKG/messages/chats?chat=${KEY}`);
    await tick(5 * 60_000);
    expect(calls.chats).toBe(1);
    expect(calls.newer).toBe(1);
    // the new message is shown, the person's own marker moved (never anything at Microsoft)
    expect(screen.getAllByTestId("message")).toHaveLength(3);
    expect(calls.read).toBe(1);
    // the list was re-read, so the person has seen it: the seen mark ran again and the dot is gone
    expect(calls.seen).toBe(2);
    expect(dotSnapshot("PKG")).toBe(false);
  });

  it("each further move of last_notice_at is exactly one more re-read; a burst of notices between two asks is one", async () => {
    await start();
    for (const n of [1, 2, 3]) {
      server.lastNoticeAt = `2026-11-23T15:0${String(n)}:00.000Z`;
      await tick(ACTIVITY_POLL_MS);
      expect(calls.chats, `notice ${String(n)}`).toBe(n);
      expect(calls.newer).toBe(n);
    }
    server.lastNoticeAt = "2026-11-23T15:09:00.000Z"; // many notices between two asks: only the last value is seen
    await tick(ACTIVITY_POLL_MS);
    expect(calls.chats).toBe(4);
  });

  it("an edited message replaces the shown one and a deleted one shows as deleted (merged by id, in time order)", async () => {
    await start();
    server.lastNoticeAt = "2026-11-23T15:00:10.000Z";
    server.newer = [msg("m1", "2026-11-23T14:00:00.000Z", { edited: true, nodes: [{ t: "text", v: "edited text" }] }), msg("m2", "2026-11-23T14:05:00.000Z", { deleted: true, nodes: [] })];
    await tick(ACTIVITY_POLL_MS);
    const texts = screen.getAllByTestId("message").map((m) => m.textContent ?? "");
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("edited text");
    expect(texts[1]).toContain("deleted");
  });

  it("two copies of one message: the one with the later lastModifiedDateTime wins, whichever source it came from", async () => {
    const edited = [msg("m1", "2026-11-23T14:00:00.000Z", { modifiedAt: "2026-11-23T16:00:00.000Z", nodes: [{ t: "text", v: "newest text" }] }), msg("m2", "2026-11-23T14:05:00.000Z")];
    render(
      <MessagesLiveProvider laneId="PKG">
        <ConversationMessages conn={CONN} laneId="PKG" chatKey={KEY} initial={edited} nextBefore={null} group />
      </MessagesLiveProvider>,
    );
    await tick(0);
    server.lastNoticeAt = "2026-11-23T15:00:10.000Z";
    server.newer = [msg("m1", "2026-11-23T14:00:00.000Z", { modifiedAt: "2026-11-23T15:00:00.000Z", nodes: [{ t: "text", v: "stale text" }] })];
    await tick(ACTIVITY_POLL_MS);
    const texts = screen.getAllByTestId("message").map((m) => m.textContent ?? "");
    expect(texts[0]).toContain("newest text");
    expect(texts[0]).not.toContain("stale text");
  });

  it("the chat list shown is replaced by the re-read (a new chat appears, its unread dot comes with it); a failed re-read keeps what is shown and says so", async () => {
    await start();
    server.chats = [row("k2", "Sam", true), row(KEY, "Pat")];
    server.lastNoticeAt = "2026-11-23T15:00:10.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(screen.getAllByTestId("chat-row").length).toBe(2);
    server.chatsStatus = 503;
    server.newerStatus = 429;
    server.lastNoticeAt = "2026-11-23T15:05:00.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(screen.getAllByTestId("chat-row").length).toBe(2); // kept
    expect(screen.getByTestId("chat-list-refresh-failed")).toBeTruthy();
    expect(screen.getByTestId("refresh-failed")).toBeTruthy();
    expect(screen.getAllByTestId("message").length).toBeGreaterThanOrEqual(2);
  });

  it("a failed or odd answer of the database changes nothing and reads nothing from Microsoft; the loop asks again", async () => {
    await start();
    server.activityStatus = 503;
    server.lastNoticeAt = "2026-11-23T15:00:10.000Z";
    await tick(2 * ACTIVITY_POLL_MS);
    expect(graphCalls()).toBe(0);
    server.activityStatus = 200;
    await tick(ACTIVITY_POLL_MS);
    expect(calls.chats).toBe(1);
  });

  it("the notice that was already there when the page opened is not a second re-read (the page's own load read Microsoft after it)", async () => {
    server.lastNoticeAt = "2026-11-23T14:59:00.000Z";
    server.dot = true;
    await start();
    await tick(5 * 60_000);
    expect(graphCalls()).toBe(0);
    expect(calls.seen).toBe(1);
  });
});

describe("the first answer (T-290 review M2, M3)", () => {
  it("a first answer that FAILS does not turn live updates off for the page view: the next tick asks again, and once the database says live the loop and the notices work", async () => {
    server.activityStatus = 503;
    await start();
    expect(calls.activity).toBe(1);
    await tick(ACTIVITY_POLL_MS);
    expect(calls.activity).toBe(2); // asked again (still the first answer)
    server.activityStatus = 200;
    await tick(ACTIVITY_POLL_MS);
    expect(calls.activity).toBe(3);
    expect(calls.seen).toBe(1); // the chat list was opened: seen, once the first answer came
    server.lastNoticeAt = "2026-11-23T15:03:00.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(calls.chats).toBe(1);
  });

  it("a first answer that keeps failing is retried every 30 s three times, then at most every 5 minutes (and at once when the tab comes back); the page never calls Microsoft meanwhile", async () => {
    server.activityStatus = 503;
    await start(); // failure 1
    await tick(ACTIVITY_POLL_MS); // 2
    await tick(ACTIVITY_POLL_MS); // 3
    expect(calls.activity).toBe(3);
    await tick(4 * 60_000); // backed off: the 30 s ticks ask nothing
    expect(calls.activity).toBe(3);
    await tick(60_000 + ACTIVITY_POLL_MS); // five minutes after the last try
    expect(calls.activity).toBe(4);
    await hide();
    await show(); // the tab coming back asks at once
    expect(calls.activity).toBe(5);
    expect(graphCalls()).toBe(0);
    server.activityStatus = 200;
    await tick(5 * 60_000 + ACTIVITY_POLL_MS);
    expect(calls.activity).toBeGreaterThanOrEqual(6);
    expect(calls.seen).toBe(1); // begun: the chat list was marked seen
  });

  it("a 401, 403 or 404 on the first answer stops the loop for the page view (no retry, not even when the tab comes back)", async () => {
    for (const status of [401, 403, 404]) {
      cleanup();
      Object.assign(calls, { activity: 0, urls: [] });
      server.activityStatus = status;
      await start();
      await tick(10 * 60_000);
      await hide();
      await show();
      expect(calls.activity, String(status)).toBe(1);
    }
  });

  it("only an explicit `live: false` stops the loop: after it, nothing more is asked", async () => {
    server.live = false;
    await start();
    await tick(10 * 60_000);
    expect(calls.activity).toBe(1);
  });

  it("a notice within 30 s of the server's clock at the first answer (it may have come after the page's server read) is ONE re-read; Refresh then honestly says up to date; an older notice is not", async () => {
    server.lastNoticeAt = "2026-11-23T14:59:45.000Z"; // 15 s before the server's now
    server.dot = true;
    await start();
    expect([calls.chats, calls.newer]).toEqual([1, 1]);
    fireEvent.click(screen.getByTestId("messages-refresh"));
    await tick(0);
    expect([calls.chats, calls.newer]).toEqual([1, 1]);
    expect(screen.getByTestId("messages-refresh-note").textContent).toMatch(/Already up to date/);
    await tick(5 * 60_000);
    expect([calls.chats, calls.newer]).toEqual([1, 1]); // the same value is not a second re-read
  });
});

describe("a sign-in that expires while its chat is open (T-288, carried from the T-296 re-check)", () => {
  it("the chat list re-read answering 409 reconnect makes ONE server refresh (guarded: a second 409 does not loop); a 409 feature_missing does not", async () => {
    await start();
    server.chatsStatus = 409;
    server.chatsError = "feature_missing";
    server.lastNoticeAt = "2026-11-23T15:00:10.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(refresh).not.toHaveBeenCalled();
    server.chatsError = "reconnect";
    server.lastNoticeAt = "2026-11-23T15:05:00.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    server.lastNoticeAt = "2026-11-23T15:10:00.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("the one-refresh guard is re-armed by a change of the accounts, not by a new array (T-288 review D2)", () => {
  it("a server render with a NEW initialRows array for the same accounts does not re-arm it: a second 409 reconnect does not refresh again", async () => {
    const tree = (rows: ChatRowView[]) => (
      <MessagesLiveProvider laneId="PKG">
        <ChatList laneId="PKG" initialRows={rows} moreCursor={null} selectedKey={KEY} initialListed={[CONN]} />
      </MessagesLiveProvider>
    );
    const view = render(tree([row(KEY, "Pat")]));
    await tick(0);
    server.chatsStatus = 409;
    server.chatsError = "reconnect";
    server.lastNoticeAt = "2026-11-23T15:00:10.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender(tree([row(KEY, "Pat")])); // the refresh's own server render: a new array, the same accounts
    await tick(0);
    server.lastNoticeAt = "2026-11-23T15:05:00.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("a truncated newer-messages page (T-290 review M4)", () => {
  it("is not merged (it could leave a hole that never closes): the conversation is read again from the server instead", async () => {
    await start();
    server.truncated = true;
    server.newer = [msg("m9", "2026-11-23T14:30:00.000Z")];
    server.lastNoticeAt = "2026-11-23T15:00:10.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(calls.newer).toBe(1);
    expect(screen.getAllByTestId("message")).toHaveLength(2); // m9 was NOT merged
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("Refresh and window focus: at most once a minute", () => {
  it("Refresh inside the first minute reads nothing and says when; after a minute it reads once; a second click reads nothing", async () => {
    await start();
    fireEvent.click(screen.getByTestId("messages-refresh"));
    await tick(0);
    expect(graphCalls()).toBe(0);
    expect(screen.getByTestId("messages-refresh-note").textContent).toMatch(/Already up to date\. You can refresh again in \d+ seconds\./);
    await tick(REFETCH_MIN_GAP_MS);
    fireEvent.click(screen.getByTestId("messages-refresh"));
    await tick(0);
    expect([calls.chats, calls.newer]).toEqual([1, 1]);
    fireEvent.click(screen.getByTestId("messages-refresh"));
    fireEvent.click(screen.getByTestId("chat-list-refresh"));
    await tick(0);
    expect([calls.chats, calls.newer]).toEqual([1, 1]);
    await tick(REFETCH_MIN_GAP_MS);
    fireEvent.click(screen.getByTestId("chat-list-refresh"));
    await tick(0);
    expect([calls.chats, calls.newer]).toEqual([2, 2]);
  });

  it("window focus: nothing inside the first minute; one re-read after it; another focus right after reads nothing", async () => {
    await start();
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await tick(0);
    expect(graphCalls()).toBe(0);
    await tick(REFETCH_MIN_GAP_MS + 1000);
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await tick(0);
    expect([calls.chats, calls.newer]).toEqual([1, 1]);
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await tick(0);
    expect([calls.chats, calls.newer]).toEqual([1, 1]);
  });

  it("a re-read caused by a notice counts as a read: a focus right after it adds none, and a notice is never held back by the minute", async () => {
    await start();
    server.lastNoticeAt = "2026-11-23T15:00:10.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(calls.chats).toBe(1);
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await tick(0);
    expect(calls.chats).toBe(1);
    server.lastNoticeAt = "2026-11-23T15:00:20.000Z";
    await tick(ACTIVITY_POLL_MS); // 30 s after the last read: a notice, so it reads
    expect(calls.chats).toBe(2);
  });

  it("without the provider (a failure card's Try again) Refresh is the old server refresh of the page", async () => {
    render(<MessagesRefresh label="Try again" />);
    fireEvent.click(screen.getByTestId("messages-refresh"));
    await tick(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("what the browser keeps and sends", () => {
  it("every request goes to this portal's own routes with the session and no cache; nothing is written to the browser's storage or cookies; no request names Microsoft", async () => {
    await start();
    server.lastNoticeAt = "2026-11-23T15:00:10.000Z";
    await tick(ACTIVITY_POLL_MS);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^\/api\/lanes\/PKG\/messages\//);
      expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    }
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(JSON.stringify(calls.urls)).not.toMatch(/graph\.microsoft|teams\.microsoft/);
  });

  it("leaving the page stops the loop and any request in flight", async () => {
    const view = page();
    await tick(0);
    view.unmount();
    const n = calls.activity;
    await tick(5 * 60_000);
    expect(calls.activity).toBe(n);
  });
});
