// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index into data they just built */
// T-288 (spec docs/specs/messages.md 10.5, 22.8): the Send box at desktop (1280) and iPhone (375) width: the composer in the pinned slot, the line under it that names the account, the counter, Ctrl/Cmd+Enter on a
// desktop only, one request for a double click, the hash of the text the browser shows, each of the five states of a sent message as TEXT and announced, the text kept after "Not sent" and after a stale
// authenticator code (the person comes back to the same chat), the sent message shown ONCE when Teams returns it, and each "why you cannot send" line. jsdom evaluates no CSS: layout is checked through the classes
// that make it. Synthetic data only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, refresh: nav.refresh }), usePathname: () => "/PKG/messages", useSearchParams: () => new URLSearchParams("") }));

import { ConversationPane, SendOff } from "./messages-chats";
import { Composer, PendingBubbles, SendScope, shownFromTeams } from "./messages-send";
import { teamsDrafts } from "@/lib/reply-draft-store";
import { SEND_OFF_TEXT, SEND_STATE_TEXT, teamsSendLine } from "@/lib/teams-wording";
import { normalizeSendText, sendTextHash, sendTextProblem } from "@/lib/teams-send-text";
import { encodeChatKey } from "@/lib/teams-chat-key";
import { clockTime, dayKey, fullTime } from "@/lib/teams-format";
import type { ConversationView, MessageView } from "@/lib/teams-chats";

const CONN = "00000000-0000-4000-8000-0000000000c1";
const USER = "00000000-0000-4000-8000-0000000000aa";
const CHAT = "19:abc123def456@thread.v2";
const KEY = encodeChatKey(CHAT);
const ACCOUNT = "robert@pubkgroup.com";
const WIDTHS = [1280, 375];
const at = (w: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  window.matchMedia = ((q: string) => ({ matches: q.includes("min-width: 1024px") ? w >= 1024 : false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
};
const msg = (id: string, iso: string, over: Partial<MessageView> = {}): MessageView => ({ id, images: null, at: iso, time: clockTime(iso), fullTime: fullTime(iso), day: dayKey(iso), sender: "Pat Example", senderKey: "k-pat", mine: false, edited: false, deleted: false, system: false, nodes: [{ t: "text", v: `text ${id}` }], truncated: false, attachments: [], ...over });
const conv = (messages: MessageView[]): ConversationView => ({ kind: "ok", chatKey: KEY, conn: CONN, account: null, accountName: null, title: "Project chat", subtitle: "2 people", external: false, group: false, openUrl: "https://teams.microsoft.com/l/chat/x/conversations", call: "available", messages, nextBefore: null, readThrough: null }) as ConversationView;

type Reply = { status: number; body: unknown } | "hang" | "throw";
let reply: Reply;
let requests: { url: string; body: Record<string, unknown> }[];
let release: (() => void) | null;
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
  if (reply === "throw") return Promise.reject(new Error("network down"));
  if (reply === "hang") return new Promise<Response>((res) => (release = () => res(new Response(JSON.stringify({ ok: true, state: "sent" }), { status: 200 }))));
  return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } }));
});
beforeEach(() => {
  at(1280);
  reply = { status: 200, body: { ok: true, state: "sent" } };
  requests = [];
  release = null;
  vi.stubGlobal("fetch", fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  nav.push.mockClear();
  nav.refresh.mockClear();
  vi.unstubAllGlobals();
});

const composer = () => (
  <SendScope>
    <ul>
      <PendingBubbles shown={[]} />
    </ul>
    <Composer laneId="PKG" conn={CONN} chatKey={KEY} account={ACCOUNT} userId={USER} />
  </SendScope>
);
const type = (text: string) => fireEvent.change(screen.getByTestId("composer-text"), { target: { value: text } });
// hashing the text is a real asynchronous step (Web Crypto): let it, and the request that follows it, finish before looking
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 25))));
const press = async () => {
  await act(async () => void fireEvent.click(screen.getByTestId("composer-send")));
  await settle();
};
const stateOf = () => screen.getAllByTestId("send-item").map((i) => i.getAttribute("data-state"));

describe("the composer in the pinned place, at both widths", () => {
  it.each(WIDTHS)("%d px: the Send box is in the composer slot under the messages, with the account line, a counter, a 44 px button and a 16 px text size on a phone (no iOS zoom)", (w) => {
    at(w);
    render(<ConversationPane view={conv([msg("m1", "2026-11-23T15:00:00.000Z")])} laneId="PKG" connectionId={CONN} send={{ kind: "ready", account: ACCOUNT }} userId={USER} />);
    const slot = screen.getByTestId("composer-slot");
    expect(within(slot).getByTestId("composer")).toBeTruthy();
    expect(within(slot).getByTestId("composer-line").textContent).toBe(`Send posts this exact text to Teams as ${ACCOUNT} (logged).`);
    expect(within(slot).getByTestId("composer-count").textContent).toBe("0 / 10,000");
    expect(within(slot).getByTestId("times-note")).toBeTruthy();
    // the messages scroll above it; the composer is not inside the scroller
    expect(within(screen.getByTestId("conversation-scroll")).queryByTestId("composer")).toBeNull();
    expect(screen.getByTestId("composer-send").className).toContain("min-h-11");
    expect(screen.getByTestId("composer-text").className).toContain("max-lg:text-base");
    expect(screen.getByTestId("composer-text").getAttribute("aria-label")).toMatch(/plain text/);
    // the keyboard hint is for a wide window only
    expect(screen.getByTestId("composer-hint").className).toContain("hidden");
    expect(screen.getByTestId("composer-hint").className).toContain("lg:block");
  });

  it("with two accounts the line names THAT account (the conversation's own), whichever the other is", () => {
    render(<ConversationPane view={conv([])} laneId="PKG" connectionId={CONN} send={{ kind: "ready", account: "robert@pub-k.org" }} userId={USER} />);
    expect(screen.getByTestId("composer-line").textContent).toBe(teamsSendLine("robert@pub-k.org"));
  });

  it("without a send view (older callers) there is no composer and no line", () => {
    render(<ConversationPane view={conv([])} laneId="PKG" connectionId={CONN} />);
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(screen.queryByTestId("send-off")).toBeNull();
  });
});

describe("why there is no Send box: one plain line naming the gate, at both widths", () => {
  const REASONS = Object.keys(SEND_OFF_TEXT) as (keyof typeof SEND_OFF_TEXT)[];
  it.each(WIDTHS)("%d px: each reason is one fixed line in the slot, with no composer", (w) => {
    at(w);
    for (const reason of REASONS) {
      const { unmount } = render(<ConversationPane view={conv([])} laneId="PKG" connectionId={CONN} send={{ kind: "off", reason }} userId={USER} />);
      const off = within(screen.getByTestId("composer-slot")).getByTestId("send-off");
      expect(off.getAttribute("data-gate")).toBe(reason);
      expect(off.textContent).toContain(SEND_OFF_TEXT[reason]);
      expect(screen.queryByTestId("composer")).toBeNull();
      expect(screen.queryByTestId("composer-text")).toBeNull();
      unmount();
    }
  });

  it("the words are the plain ones (spec 10.5), and only `reconnect` offers the Reconnect button, for THAT connection", () => {
    expect(SEND_OFF_TEXT.lane_off).toBe("Sending is not switched on for this company yet.");
    expect(SEND_OFF_TEXT.reconnect).toBe("Reconnect Teams to allow sending.");
    const { container, rerender } = render(<SendOff reason="reconnect" laneId="PKG" connectionId={CONN} />);
    const form = container.querySelector("form");
    expect(form?.getAttribute("action")).toBe(`/api/connect/teams/start?lane=PKG&connection=${CONN}`);
    rerender(<SendOff reason="lane_off" laneId="PKG" connectionId={CONN} />);
    expect(container.querySelector("form")).toBeNull();
  });
});

describe("sending", () => {
  it("one press: ONE request to this lane's send route naming THIS conversation's connection and chat, with the hash of the text as the browser shows it (line breaks, accents and spaces made canonical)", async () => {
    render(composer());
    type("  Hello\r\nworld é  ");
    await press();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/api/lanes/PKG/messages/send");
    const b = requests[0]!.body;
    expect(Object.keys(b).sort()).toEqual(["chat", "clientRequestId", "conn", "text", "textSha256"]);
    expect(b).toMatchObject({ conn: CONN, chat: KEY });
    expect(b.clientRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b.textSha256).toBe(await sendTextHash("Hello\nworld é"));
    expect(b.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await sendTextHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); // the standard SHA-256 test vector
  });

  it("a double click (and a held key) is one request while the first is open; the button says Sending…", async () => {
    reply = "hang";
    render(composer());
    type("hello");
    await act(async () => {
      fireEvent.click(screen.getByTestId("composer-send"));
      fireEvent.click(screen.getByTestId("composer-send"));
    });
    await settle();
    await act(async () => void fireEvent.keyDown(screen.getByTestId("composer-text"), { key: "Enter", ctrlKey: true }));
    await settle();
    expect(requests).toHaveLength(1);
    expect(screen.getByTestId("composer-send").textContent).toBe("Sending…");
    expect(stateOf()).toEqual(["sending"]);
    await act(async () => release?.());
    await settle();
    expect(stateOf()).toEqual(["sent"]);
  });

  it("Ctrl+Enter and Cmd+Enter send on a desktop; plain Enter does not (it is a new line); on a phone no key sends, only the button", async () => {
    render(composer());
    type("one");
    await act(async () => void fireEvent.keyDown(screen.getByTestId("composer-text"), { key: "Enter" }));
    expect(requests).toHaveLength(0);
    await act(async () => void fireEvent.keyDown(screen.getByTestId("composer-text"), { key: "Enter", ctrlKey: true }));
    await settle();
    expect(requests).toHaveLength(1);
    type("two");
    await act(async () => void fireEvent.keyDown(screen.getByTestId("composer-text"), { key: "Enter", metaKey: true }));
    await settle();
    expect(requests).toHaveLength(2);
    cleanup();
    at(375);
    render(composer());
    type("phone");
    await act(async () => void fireEvent.keyDown(screen.getByTestId("composer-text"), { key: "Enter", ctrlKey: true }));
    await act(async () => void fireEvent.keyDown(screen.getByTestId("composer-text"), { key: "Enter", metaKey: true }));
    await settle();
    expect(requests).toHaveLength(2);
    await press();
    expect(requests).toHaveLength(3);
  });

  it("nothing is sent for an empty message, one over 10,000 characters or one with a control character; the counter and the reason say so", async () => {
    render(composer());
    await press();
    type("   \n ");
    await press();
    type("x".repeat(10_001));
    expect(screen.getByTestId("composer-count").textContent).toBe("10,001 / 10,000");
    expect(screen.getByTestId("composer-problem").textContent).toMatch(/longer than 10,000/);
    await press();
    type("bell\u0007");
    expect(screen.getByTestId("composer-problem").textContent).toMatch(/character Teams cannot take/);
    await press();
    expect(requests).toHaveLength(0);
    expect(screen.getByTestId("composer-send").getAttribute("aria-disabled")).toBe("true");
    expect(sendTextProblem("ok")).toBeNull();
    expect(sendTextProblem("😀".repeat(10_000))).toBeNull(); // 10,000 characters of 4 bytes is 40 KB: the 80 KB bound can never be the first one hit
  });
});

describe("the five states, as text and announced", () => {
  const CASES: [string, Reply, string, string][] = [
    ["sent", { status: 200, body: { ok: true, state: "sent" } }, "sent", SEND_STATE_TEXT.sent],
    ["checking", { status: 200, body: { ok: true, state: "checking" } }, "checking", SEND_STATE_TEXT.checking],
    ["not sent", { status: 200, body: { ok: true, state: "not_sent", code: "not_a_member", message: "You are not a member of this chat or channel, or sending is not allowed" } }, "not_sent", "Not sent: You are not a member of this chat or channel, or sending is not allowed"],
    ["unknown", { status: 200, body: { ok: true, state: "unknown" } }, "unknown", SEND_STATE_TEXT.unknown],
  ];
  it.each(CASES)("%s: the bubble shows the text of the message and the state in words; the live region says it", async (_n, r, state, words) => {
    reply = r;
    render(composer());
    type("my message");
    await press();
    await settle();
    expect(stateOf()).toEqual([state]);
    const item = screen.getByTestId("send-item");
    expect(within(item).getByTestId("send-text").textContent).toBe("my message");
    expect(within(item).getByTestId("send-state").textContent).toContain(words.replace("Sent, checking…", "Sent, checking…"));
    expect(screen.getByTestId("composer-announce").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByTestId("composer-announce").getAttribute("role")).toBe("status");
    expect(screen.getByTestId("composer-announce").textContent).toContain(words);
  });

  it("each state has its own words AND its own mark, so none depends on colour", () => {
    expect(new Set(Object.values(SEND_STATE_TEXT)).size).toBe(5);
    expect(SEND_STATE_TEXT).toEqual({ sending: "Sending…", sent: "Sent", checking: "Sent, checking…", not_sent: "Not sent", unknown: "Outcome unknown: check the chat in Teams before sending again" });
  });

  it("Sending… is shown while the request is open", async () => {
    reply = "hang";
    render(composer());
    type("x");
    await press();
    expect(stateOf()).toEqual(["sending"]);
    expect(screen.getByTestId("send-state").textContent).toContain("Sending…");
    expect(screen.getByTestId("composer-announce").textContent).toBe("Sending…");
    await act(async () => release?.());
  });

  it("Sent and Outcome unknown clear the box; Not sent KEEPS the text so the person can try again, and the next press is a NEW message (a new request id) with the old Not sent bubble gone", async () => {
    reply = { status: 200, body: { ok: true, state: "not_sent", code: "throttled", message: "Teams is busy, so nothing was sent. Press Send again in a moment" } };
    render(composer());
    type("keep me");
    await press();
    await settle();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("keep me");
    reply = { status: 200, body: { ok: true, state: "sent" } };
    await press();
    await settle();
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body.clientRequestId).not.toBe(requests[1]!.body.clientRequestId);
    expect(stateOf()).toEqual(["sent"]);
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("");
  });

  it("a refusal before anything was sent (a gate, a wrong hash, rate limit, expired sign-in) is Not sent with its own fixed sentence and the text kept", async () => {
    for (const [status, error, words] of [[409, "gate_not_live", SEND_OFF_TEXT.not_live], [409, "gate_reconnect", SEND_OFF_TEXT.reconnect], [400, "text_mismatch", "changed while it was being sent"], [429, "rate_limited", "Wait a second"], [409, "reconnect", "sign-in expired"], [404, "not_found", "could not be found"]] as const) {
      reply = { status, body: { error } };
      render(composer());
      type("stays");
      await press();
      await settle();
      expect(stateOf()).toEqual(["not_sent"]);
      expect(screen.getByTestId("send-state").textContent).toContain(words);
      expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("stays");
      cleanup();
    }
  });

  it("an unknown outcome from the server (502) and a request with no answer are Outcome unknown: the text leaves the box (never a blind resend), the bubble keeps what was sent, no second request is made", async () => {
    for (const r of [{ status: 502, body: { error: "unknown_outcome" } }, "throw"] as Reply[]) {
      reply = r;
      render(composer());
      type("maybe gone");
      await press();
      await settle();
      expect(stateOf()).toEqual(["unknown"]);
      expect(screen.getByTestId("send-text").textContent).toBe("maybe gone");
      expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("");
      expect(requests.length).toBe(1);
      requests = [];
      cleanup();
    }
  });
});

describe("a stale authenticator code: the person enters it and comes back to the same chat with the text kept", () => {
  it("403 step_up_required keeps the text in THIS tab only, shows the step in words, and goes to /mfa?reauth=1 with the chat's own address to return to", async () => {
    reply = { status: 403, body: { error: "step_up_required" } };
    render(composer());
    type("typed before the code");
    await press();
    await settle();
    expect(screen.getByTestId("composer-note").textContent).toMatch(/Enter your authenticator code to send/);
    expect(screen.queryByTestId("send-item")).toBeNull(); // nothing was proposed: no bubble
    expect(nav.push).toHaveBeenCalledTimes(1);
    const to = String(nav.push.mock.calls[0]?.[0]);
    expect(to.startsWith("/mfa?reauth=1&next=")).toBe(true);
    expect(decodeURIComponent(to.split("next=")[1] ?? "")).toBe(`/PKG/messages?conn=${CONN}&chat=${KEY}`);
    expect(teamsDrafts.read("PKG", USER, `${CONN}:${KEY}`)).toEqual({ text: "typed before the code" });
    // back on the chat: a fresh composer shows the text again, and the next press sends it
    cleanup();
    reply = { status: 200, body: { ok: true, state: "sent" } };
    render(composer());
    await waitFor(() => expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("typed before the code"));
    await press();
    await settle();
    expect(requests.at(-1)?.body.text).toBe("typed before the code");
    expect(teamsDrafts.read("PKG", USER, `${CONN}:${KEY}`)).toBeNull(); // sent: the tab's copy is gone
  });

  it("the copy is per conversation: another chat or another account's composer never shows it", async () => {
    teamsDrafts.write("PKG", USER, `${CONN}:${KEY}`, { text: "for this chat" });
    render(<SendScope><Composer laneId="PKG" conn="00000000-0000-4000-8000-0000000000c2" chatKey={KEY} account="robert@pub-k.org" userId={USER} /></SendScope>);
    await settle();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("");
    cleanup();
    render(<SendScope><Composer laneId="PKG" conn={CONN} chatKey={KEY} account={ACCOUNT} userId="00000000-0000-4000-8000-0000000000bb" /></SendScope>);
    await settle();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe(""); // another person on this tab
  });
});

describe("after Sent the conversation shows the message from Teams once", () => {
  it("shownFromTeams: one of the person's own messages with the same text (line breaks and spaces aside) after the press; not another person's, not an older one, not different text", () => {
    const item = { text: "Hello\nworld", at: Date.parse("2026-11-23T15:00:00.000Z") };
    const mine = (over: Partial<MessageView>) => msg("t1", "2026-11-23T15:00:05.000Z", { mine: true, nodes: [{ t: "p", c: [{ t: "text", v: "Hello" }, { t: "br" }, { t: "text", v: "world" }] }], ...over });
    expect(shownFromTeams(item, [mine({})])).toBe(true);
    expect(shownFromTeams(item, [mine({ mine: false })])).toBe(false);
    expect(shownFromTeams(item, [mine({ at: "2026-11-23T14:00:00.000Z" })])).toBe(false);
    expect(shownFromTeams(item, [mine({ nodes: [{ t: "text", v: "Hello there" }] })])).toBe(false);
    expect(shownFromTeams(item, [mine({ deleted: true })])).toBe(false);
  });

  it("the local bubble is hidden once the list holds the same message, so it is never drawn twice; Not sent and Outcome unknown bubbles stay", async () => {
    const Both = ({ shown }: { shown: MessageView[] }) => (
      <SendScope>
        <ul>
          <PendingBubbles shown={shown} />
        </ul>
        <Composer laneId="PKG" conn={CONN} chatKey={KEY} account={ACCOUNT} userId={USER} />
      </SendScope>
    );
    const view = render(<Both shown={[]} />);
    type("same words");
    await press();
    await settle();
    expect(screen.getAllByTestId("send-item")).toHaveLength(1);
    view.rerender(<Both shown={[msg("t9", new Date(Date.now() + 5000).toISOString(), { mine: true, nodes: [{ t: "p", c: [{ t: "text", v: "same words" }] }] })]} />);
    expect(screen.queryAllByTestId("send-item")).toHaveLength(0);
  });
});

describe("source rules", () => {
  const src = readFileSync(join(__dirname, "messages-send.tsx"), "utf8");
  it("no HTML injection, no localStorage or cookie, no timer, no clock read while rendering, no direct sessionStorage (only the draft store), no Microsoft call", () => {
    expect(src).not.toMatch(/dangerouslySetInnerHTML|localStorage|document\.cookie|setInterval|graph\.microsoft|sessionStorage/);
    // the one clock read is in the press handler
    expect([...src.matchAll(/Date\.now\(\)/g)].length).toBe(1);
    expect(normalizeSendText("  a\r\nb  ")).toBe("a\nb");
  });
});
