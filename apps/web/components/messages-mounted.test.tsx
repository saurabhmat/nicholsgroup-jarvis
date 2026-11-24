// @vitest-environment jsdom
// T-296 (docs/specs/messages.md 22.6): the chat list is drawn once by the Messages layout and stays MOUNTED while only the address changes. A chat click changes `?conn=` / `?chat=`: the list reads
// NOTHING (no `/messages/chats` request), moves its highlight, and clears the opened chat's dot in the browser. On the Channels tab the list is hidden: a notice then reads nothing and marks nothing seen;
// when the Chats tab comes back one read follows. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ search: "", refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: nav.refresh }), usePathname: () => "/PKG/messages", useSearchParams: () => new URLSearchParams(nav.search) }));

import { ChatListLive, MessagesLiveProvider } from "./messages-live";
import { ByTab, MessagesScope } from "./messages-scope";
import { resetDotForTests } from "@/lib/messages-activity-client";
import { viewOf } from "@/lib/messages-view-state";
import { ACTIVITY_POLL_MS } from "@/lib/messages-live-config";
import { encodeChatKey } from "@/lib/teams-chat-key";
import { encodeChannelKey } from "@/lib/teams-channel-key";
import type { ChatRowView } from "@/lib/teams-chats";

const A = "00000000-0000-4000-8000-0000000000c1";
const B = "00000000-0000-4000-8000-0000000000c2";
const OTHER = "00000000-0000-4000-8000-0000000000d1";
const K1 = encodeChatKey("19:one111@thread.v2");
const K2 = encodeChatKey("19:two222@thread.v2");
const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1";
const row = (conn: string, key: string, title: string, over: Partial<ChatRowView> = {}): ChatRowView => ({
  key, conn, account: conn === A ? "pubkgroup.com" : "pub-k.org", accountName: conn === A ? "robert@pubkgroup.com" : "robert@pub-k.org", at: "2026-11-23T14:00:00.000Z", ord: conn === A ? 0 : 1,
  title, preview: `p ${title}`, time: "9:00 AM", unread: false, external: false, ...over,
});
const q = (s: string) => new URLSearchParams(s);

describe("viewOf: what the address says (pure)", () => {
  const conns = [A, B];
  it("a chat opens as the account named; the list stays on a phone for anything that no account of the person opens", () => {
    expect(viewOf(q(`conn=${B}&chat=${K1}`), conns)).toMatchObject({ tab: "chats", view: "chat", open: true, chatKey: K1, conn: B });
    expect(viewOf(q(""), conns)).toMatchObject({ view: "list", open: false, chatKey: null, conn: null });
    // two accounts and no conn: no guess; another person's / uppercase / malformed conn: nothing opens, nothing falls back
    for (const bad of [`chat=${K1}`, `conn=${OTHER}&chat=${K1}`, `conn=${A.toUpperCase()}&chat=${K1}`, `conn=../x&chat=${K1}`, `conn=${B}&chat=not-a-key`, `conn=${B}&chat=../../etc`]) expect(viewOf(q(bad), conns).view, bad).toBe("list");
  });
  it("M1: a `conn` that is not one of the person's own usable accounts is never handed on (the list would send it as `open=` and be refused)", () => {
    expect(viewOf(q(`conn=${OTHER}&chat=${K1}`), conns).conn).toBeNull();
    expect(viewOf(q(`conn=${A.toUpperCase()}&chat=${K1}`), conns).conn).toBeNull();
    expect(viewOf(q(`conn=${B}&chat=${K1}`), conns).conn).toBe(B);
    expect(viewOf(q(`conn=${OTHER}&chat=${K1}`), conns).open).toBe(false);
  });
  it("with exactly one usable account an old link without conn still opens", () => {
    expect(viewOf(q(`chat=${K1}`), [A])).toMatchObject({ view: "chat", open: true, conn: null });
  });
  it("the Channels tab: its own view; a channel is open only with a team id and a channel key that decode", () => {
    expect(viewOf(q("tab=channels"), [A])).toMatchObject({ tab: "channels", view: "channels", open: false });
    expect(viewOf(q(`tab=channels&team=${TEAM}&channel=${encodeChannelKey("19:general111@thread.tacv2")}`), [A])).toMatchObject({ view: "channels", open: true });
    expect(viewOf(q(`tab=channels&team=${TEAM}&channel=nope`), [A]).open).toBe(false);
    expect(viewOf(q(`tab=channels&team=../x&channel=${encodeChannelKey("19:general111@thread.tacv2")}`), [A]).open).toBe(false);
    expect(viewOf(q("tab=other"), [A]).tab).toBe("chats");
  });
});

describe("the scope and the tab switch", () => {
  afterEach(cleanup);
  it("sets the data attributes the panes' classes read, and mounts only the notes of the open tab", () => {
    nav.search = `conn=${A}&chat=${K1}`;
    const { rerender } = render(
      <MessagesScope chatConns={[A, B]}>
        <ByTab chats={<p>chat notes</p>} channels={<p>channel notes</p>} />
      </MessagesScope>,
    );
    const scope = screen.getByTestId("messages-scope");
    expect([scope.getAttribute("data-tab"), scope.getAttribute("data-view"), scope.getAttribute("data-open")]).toEqual(["chats", "chat", "true"]);
    expect(screen.getByText("chat notes")).toBeTruthy();
    expect(screen.queryByText("channel notes")).toBeNull();
    nav.search = "tab=channels";
    rerender(
      <MessagesScope chatConns={[A, B]}>
        <ByTab chats={<p>chat notes</p>} channels={<p>channel notes</p>} />
      </MessagesScope>,
    );
    expect([scope.getAttribute("data-tab"), scope.getAttribute("data-view"), scope.getAttribute("data-open")]).toEqual(["channels", "channels", "false"]);
    expect(screen.getByText("channel notes")).toBeTruthy();
    expect(screen.queryByText("chat notes")).toBeNull();
  });
});

describe("the mounted chat list", () => {
  const calls = { urls: [] as string[], seen: [] as unknown[] };
  let notices: Record<string, string | null>;
  const json = (status: number, body: unknown) => Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    calls.urls.push(`${init?.method ?? "GET"} ${u}`);
    if (u.includes("/messages/activity")) {
      if (init?.method === "POST") {
        calls.seen.push(init.body === undefined ? null : JSON.parse(String(init.body)));
        return json(200, { live: true, liveUntil: null, dot: false, lastNoticeAt: null, accounts: [] });
      }
      const accounts = [A, B].map((conn) => ({ conn, live: true, liveUntil: null, dot: false, lastNoticeAt: notices[conn] ?? null }));
      return json(200, { live: true, liveUntil: null, dot: false, lastNoticeAt: null, serverNow: new Date().toISOString(), accounts });
    }
    if (u.includes("/messages/chats")) return json(200, { rows: [row(A, K1, "One"), row(B, K2, "Two")], moreCursor: null, notes: [], listed: [A, B] });
    throw new Error(`unexpected request ${u}`);
  });
  const tick = async (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const tree = () => (
    <MessagesScope chatConns={[A, B]}>
      <MessagesLiveProvider laneId="PKG" expectLists>
        <ChatListLive laneId="PKG" initialRows={[row(A, K1, "One", { unread: true }), row(B, K2, "Two", { unread: true }), row(B, K1, "One too", { unread: true })]} moreCursor={null} initialListed={[A, B]} />
      </MessagesLiveProvider>
    </MessagesScope>
  );
  const chatReads = () => calls.urls.filter((u) => u.includes("/messages/chats"));
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T15:00:00.000Z"));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    calls.urls = [];
    calls.seen = [];
    notices = {};
    nav.search = "";
    resetDotForTests();
    fetchMock.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const dots = () => screen.getAllByTestId("chat-row").map((r) => r.getAttribute("data-unread"));
  const current = () => screen.getAllByTestId("chat-row").map((r) => r.getAttribute("aria-current"));

  it("a chat click (the address changes) reads no list: the highlight moves, the opened pair's dot goes and stays gone after leaving it; the other account's row of the same chat keeps its dot", async () => {
    const { rerender } = render(tree());
    await tick(0);
    expect(dots()).toEqual(["true", "true", "true"]);
    calls.urls = [];
    nav.search = `conn=${A}&chat=${K1}`; // click: One as A
    rerender(tree());
    await tick(0);
    expect(dots()).toEqual(["false", "true", "true"]);
    expect(current()).toEqual(["page", null, null]);
    nav.search = `conn=${B}&chat=${K2}`; // click: Two as B
    rerender(tree());
    await tick(0);
    expect(dots()).toEqual(["false", "false", "true"]); // One (A) stays read after leaving it; One too (B) is another pair
    expect(current()).toEqual([null, "page", null]);
    nav.search = `conn=${B}&chat=${K1}`;
    rerender(tree());
    await tick(0);
    expect(dots()).toEqual(["false", "false", "false"]);
    expect(chatReads()).toEqual([]); // THREE clicks, ZERO list reads
  });

  it.each([
    ["a stale or foreign conn", `conn=${OTHER}&chat=${K1}`],
    ["two accounts and no conn", `chat=${K1}`],
  ])("M1 / L2, %s: not 'the open chat': no `chat` / `open` on a re-read, no dot cleared, no highlight", async (_n, search) => {
    nav.search = search;
    render(tree());
    await tick(0);
    expect(dots()).toEqual(["true", "true", "true"]);
    expect(current()).toEqual([null, null, null]);
    calls.urls = [];
    notices[B] = "2026-11-23T15:00:20.000Z";
    await tick(ACTIVITY_POLL_MS);
    const reads = chatReads();
    expect(reads.length).toBeGreaterThan(0);
    for (const u of reads) expect(u).not.toMatch(/[?&](open|chat)=/);
  });

  it("L3: a re-read the server refuses as a whole (401, 403, 404) draws the layout again ONCE with the server's state; a second refusal does not loop", async () => {
    nav.search = "";
    nav.refresh.mockClear();
    const real = fetchMock.getMockImplementation() as (u: string, i?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation((u: string, i?: RequestInit) => {
      if (!String(u).includes("/messages/chats")) return real(u, i);
      calls.urls.push(`GET ${String(u)}`);
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    try {
    render(tree());
    await tick(0);
    notices[B] = "2026-11-23T15:00:20.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(chatReads()).toHaveLength(1);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    notices[B] = "2026-11-23T15:01:20.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(chatReads()).toHaveLength(2);
    expect(nav.refresh).toHaveBeenCalledTimes(1); // guarded
    } finally {
      fetchMock.mockImplementation(real);
    }
  });

  it("a notice of one account while a chat is open re-reads that account's list through the route (with the open chat), and the rows it brings carry the markers", async () => {
    nav.search = `conn=${A}&chat=${K1}`;
    render(tree());
    await tick(0);
    calls.urls = [];
    notices[B] = "2026-11-23T15:00:20.000Z";
    await tick(ACTIVITY_POLL_MS);
    const reads = chatReads();
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain(`conn=${B}`);
    expect(reads[0]).toContain(`chat=${K1}`);
    expect(reads[0]).toContain(`open=${A}`);
  });

  it("on the Channels tab the list is hidden: a notice reads nothing and marks nothing seen; the Chats tab coming back reads every account ONCE", async () => {
    nav.search = "tab=channels";
    const { rerender } = render(tree());
    await tick(0);
    expect(calls.seen).toEqual([]); // the hidden list was not seen: no "seen" for it
    calls.urls = [];
    notices[B] = "2026-11-23T15:00:20.000Z";
    await tick(ACTIVITY_POLL_MS);
    expect(chatReads()).toEqual([]);
    expect(calls.seen).toEqual([]);
    nav.search = "";
    rerender(tree());
    await tick(0);
    expect(chatReads()).toHaveLength(1); // one request for every account
    expect(chatReads()[0]).not.toContain("conn=");
    // and coming back without a missed notice reads nothing
    calls.urls = [];
    nav.search = "tab=channels";
    rerender(tree());
    nav.search = "";
    rerender(tree());
    await tick(0);
    expect(chatReads()).toEqual([]);
  });
});

describe("the phone pane's height is measured from the real chrome (T-297 review M2)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.querySelectorAll('[data-slot="tab-bar"]').forEach((e) => e.remove());
  });
  const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  it("--pane-h = window height - tab bar height - the right column's distance from the top of the page, so the pane ends exactly above the tab bar", () => {
    nav.search = `conn=${A}&chat=${K1}`;
    const bar = document.createElement("nav");
    bar.setAttribute("data-slot", "tab-bar");
    bar.getBoundingClientRect = () => rect(0, 64);
    document.body.appendChild(bar);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return this.getAttribute("data-testid") === "messages-right" ? rect(210, 500) : orig.call(this);
    };
    try {
      render(
        <MessagesScope chatConns={[A]}>
          <div data-testid="messages-right" />
        </MessagesScope>,
      );
      expect(screen.getByTestId("messages-scope").style.getPropertyValue("--pane-h")).toBe("526px"); // 800 - 64 - 210
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig;
    }
  });
  describe("the on-screen keyboard (T-288; the visual viewport shrinks, the window does not)", () => {
    const origRect = HTMLElement.prototype.getBoundingClientRect;
    const vvFake = (height: number, offsetTop: number) => {
      const listeners = new Map<string, Set<() => void>>();
      const vv = {
        height,
        offsetTop,
        addEventListener: (t: string, f: () => void) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t))?.add(f),
        removeEventListener: (t: string, f: () => void) => void listeners.get(t)?.delete(f),
        fire: (t: string) => listeners.get(t)?.forEach((f) => f()),
      };
      Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
      return vv;
    };
    const setup = (opts: { top?: number } = {}) => {
      nav.search = `conn=${A}&chat=${K1}`;
      const bar = document.createElement("nav");
      bar.setAttribute("data-slot", "tab-bar");
      bar.getBoundingClientRect = () => rect(0, 64);
      document.body.appendChild(bar);
      vi.stubGlobal("matchMedia", () => ({ matches: false }));
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
      Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
      HTMLElement.prototype.getBoundingClientRect = function () {
        return this.getAttribute("data-testid") === "messages-right" ? rect(opts.top ?? 210, 500) : origRect.call(this);
      };
      render(
        <MessagesScope chatConns={[A]}>
          <div data-testid="messages-right">
            <textarea data-testid="box" />
            <button type="button" data-testid="btn" />
            <input data-testid="check" type="checkbox" />
            <input data-testid="line" type="text" />
          </div>
        </MessagesScope>,
      );
    };
    const pane = () => screen.getByTestId("messages-scope").style.getPropertyValue("--pane-h");
    afterEach(() => {
      HTMLElement.prototype.getBoundingClientRect = origRect;
      Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    });

    it("with a field focused and the keyboard up the pane ends at the bottom of the VISUAL viewport (height + offsetTop - column top), the tab bar left out: 440 + 0 - 210 = 230, floored at 256", () => {
      const vv = vvFake(800, 0);
      setup();
      expect(pane()).toBe("526px"); // no keyboard: the old sum (800 - 64 - 210)
      vv.height = 480; // an iPhone keyboard: 320 px
      act(() => void screen.getByTestId("box").focus());
      // 480 + 0 - 210 = 270
      expect(pane()).toBe("270px");
    });

    it("offsetTop is part of the sum: when iOS has scrolled the view 40 px, the pane reaches 40 px further down the window", () => {
      const vv = vvFake(800, 0);
      setup();
      vv.height = 480;
      vv.offsetTop = 40;
      act(() => void screen.getByTestId("box").focus());
      expect(pane()).toBe("310px"); // 480 + 40 - 210
      vv.offsetTop = 80;
      act(() => vv.fire("scroll")); // iOS moved the visual viewport: measured again
      expect(pane()).toBe("350px");
    });

    it("blur puts the sum back (with the tab bar); a button, a checkbox or a click elsewhere is not a keyboard; focus moving to another field keeps the keyboard sizing", () => {
      const vv = vvFake(800, 0);
      setup();
      vv.height = 480;
      act(() => void screen.getByTestId("btn").focus());
      expect(pane()).toBe("526px"); // a button opens no keyboard
      act(() => void screen.getByTestId("check").focus());
      expect(pane()).toBe("526px");
      act(() => void screen.getByTestId("box").focus());
      expect(pane()).toBe("270px");
      act(() => void screen.getByTestId("line").focus());
      expect(pane()).toBe("270px"); // field to field: still up
      act(() => void screen.getByTestId("line").blur());
      expect(pane()).toBe("526px"); // restored
    });

    it("a visual viewport only a little shorter than the window (a collapsing address bar, under 120 px) is not the keyboard", () => {
      const vv = vvFake(800, 0);
      setup();
      vv.height = 720;
      act(() => void screen.getByTestId("box").focus());
      expect(pane()).toBe("526px");
      vv.height = 680; // exactly 120 short: still not more than 120
      act(() => vv.fire("resize"));
      expect(pane()).toBe("526px");
      vv.height = 679;
      act(() => vv.fire("resize"));
      expect(pane()).toBe("469px"); // 679 + 0 - 210
    });

    it("the keyboard shrinking the window itself (Android: innerHeight follows) changes nothing: the old sum applies and the field's focus is not a second correction", () => {
      vvFake(600, 0);
      setup();
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
      act(() => void screen.getByTestId("box").focus());
      expect(pane()).toBe("326px"); // 600 - 64 - 210
    });

    it("the minimum pane height (256 px) is kept when the visual viewport is very short", () => {
      const vv = vvFake(800, 0);
      setup({ top: 150 });
      vv.height = 300;
      act(() => void screen.getByTestId("box").focus());
      expect(pane()).toBe("200px"); // 300 - 150 = 150, floored at 200 with the keyboard up (the 256 px minimum is dropped; the pane's own CSS minimum goes too)
      expect(screen.getByTestId("messages-scope").style.getPropertyValue("--pane-min")).toBe("0px");
      act(() => void screen.getByTestId("box").blur());
      expect(screen.getByTestId("messages-scope").style.getPropertyValue("--pane-min")).toBe("");
    });

    it("the listeners are removed when the scope unmounts", () => {
      const vv = vvFake(800, 0);
      setup();
      cleanup();
      vv.height = 100;
      expect(() => vv.fire("resize")).not.toThrow();
    });
  });
  it("on a wide window the variable is not set (the panes are sized by the flex chain)", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    render(
      <MessagesScope chatConns={[A]}>
        <div data-testid="messages-right" />
      </MessagesScope>,
    );
    expect(screen.getByTestId("messages-scope").style.getPropertyValue("--pane-h")).toBe("");
  });
});
