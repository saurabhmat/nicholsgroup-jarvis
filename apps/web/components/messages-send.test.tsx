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
import { classifyAnswer, Composer, hiddenItems, nextAnnounce, PendingBubbles, SendScope } from "./messages-send";
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

type Reply = { status: number; body: unknown } | { status: number; raw: string } | "hang" | "throw";
let reply: Reply;
let queue: Reply[] = [];
let atRequest: (() => void) | null = null;
let requests: { url: string; body: Record<string, unknown> }[];
let release: (() => void) | null;
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
  atRequest?.();
  const answer: Reply = queue.length > 0 ? (queue.shift() as Reply) : reply;
  if (answer === "throw") return Promise.reject(new Error("network down"));
  if (answer === "hang") return new Promise<Response>((res) => (release = () => res(new Response(JSON.stringify(reply === "hang" ? { ok: true, state: "sent" } : (reply as { body: unknown }).body), { status: 200 }))));
  if ("raw" in answer) return Promise.resolve(new Response(answer.raw, { status: answer.status, headers: { "content-type": "text/html" } }));
  return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }));
});
beforeEach(() => {
  at(1280);
  reply = { status: 200, body: { ok: true, state: "sent" } };
  requests = [];
  queue = [];
  atRequest = null;
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

const Chat = ({ shown = [], conn = CONN, user = USER, account = ACCOUNT }: { shown?: MessageView[]; conn?: string; user?: string; account?: string }) => (
  <SendScope laneId="PKG" conn={conn} chatKey={KEY} userId={user} enabled>
    <ul>
      <PendingBubbles shown={shown} />
    </ul>
    <Composer laneId="PKG" conn={conn} chatKey={KEY} account={account} userId={user} />
  </SendScope>
);
const composer = () => <Chat />;
const type = (text: string) => fireEvent.change(screen.getByTestId("composer-text"), { target: { value: text } });
// hashing the text is a real asynchronous step (Web Crypto): let it, and the request that follows it, finish before looking
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 25))));
const press = async () => {
  await act(async () => void fireEvent.click(screen.getByTestId("composer-send")));
  await settle();
};
const announced = () => (screen.getByTestId("composer-announce").textContent ?? "").replaceAll("\u200b", "");
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
    expect(announced()).toContain(words);
  });

  it("each state has its own words AND its own mark, so none depends on colour", () => {
    expect(new Set(Object.values(SEND_STATE_TEXT)).size).toBe(5);
    expect(SEND_STATE_TEXT).toEqual({ sending: "Sending…", sent: "Sent", checking: "Sent, checking…", not_sent: "Not sent", unknown: "This message may have been sent. Look at the chat in Teams first." });
  });

  it("Sending… is shown while the request is open", async () => {
    reply = "hang";
    render(composer());
    type("x");
    await press();
    expect(stateOf()).toEqual(["sending"]);
    expect(screen.getByTestId("send-state").textContent).toContain("Sending…");
    expect(announced()).toBe("Sending…");
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
    for (const [status, error, words] of [[409, "gate_not_live", SEND_OFF_TEXT.not_live], [409, "gate_reconnect", SEND_OFF_TEXT.reconnect], [400, "text_mismatch", "changed on its way"], [429, "rate_limited", "Wait a second"], [409, "reconnect", "sign-in expired"], [404, "not_found", "could not be found"]] as const) {
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
    render(<Chat conn="00000000-0000-4000-8000-0000000000c2" account="robert@pub-k.org" />);
    await settle();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("");
    cleanup();
    render(<Chat user="00000000-0000-4000-8000-0000000000bb" />);
    await settle();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe(""); // another person on this tab
  });
});

describe("after Sent the conversation shows each message from Teams once (one to one)", () => {
  const mine = (id: string, text: string, iso = "2026-11-23T15:00:05.000Z", over: Partial<MessageView> = {}) => msg(id, iso, { mine: true, nodes: [{ t: "p", c: [{ t: "text", v: text }] }], ...over });
  const item = (over: Partial<Parameters<typeof hiddenItems>[0][number]> = {}) => ({ id: "r1", text: "Hello\nworld", at: Date.parse("2026-11-23T15:00:00.000Z"), state: "checking" as const, messageId: null, ...over });
  it("an item with the message id from the server is hidden by THAT message only, whatever its text looks like (a link, another form)", () => {
    const i = item({ state: "sent", messageId: "g1", text: "see https://example.test" });
    expect([...hiddenItems([i], [mine("g1", "see example.test link")])]).toEqual(["r1"]);
    expect([...hiddenItems([i], [mine("g2", "see https://example.test")])]).toEqual([]); // same text, another message: not this one
  });
  it("without an id, one Teams message hides at most ONE bubble, oldest first; two sends of the same text need two messages", () => {
    const a = item({ id: "r1", text: "ok" });
    const b = item({ id: "r2", text: "ok", at: Date.parse("2026-11-23T15:00:30.000Z") });
    expect([...hiddenItems([a, b], [mine("g1", "ok")])]).toEqual(["r1"]);
    expect([...hiddenItems([a, b], [mine("g1", "ok"), mine("g2", "ok", "2026-11-23T15:00:40.000Z")])]).toEqual(["r1", "r2"]);
    // a message another bubble owns by id is not taken by text
    expect([...hiddenItems([item({ id: "r3", state: "sent", messageId: "g1", text: "ok" }), a], [mine("g1", "ok")])]).toEqual(["r3"]);
  });
  it("not another person's message, not an older one, not different text, not a deleted one, not a bubble that is still sending or not sent", () => {
    for (const m of [mine("g", "Hello world", undefined, { mine: false }), mine("g", "Hello world", "2026-11-23T14:00:00.000Z"), mine("g", "Hello there"), mine("g", "Hello world", undefined, { deleted: true })]) expect(hiddenItems([item()], [m]).size).toBe(0);
    expect(hiddenItems([item()], [mine("g", "Hello world")]).size).toBe(1); // line breaks and spaces aside
    for (const state of ["sending", "not_sent", "unknown"] as const) expect(hiddenItems([item({ state })], [mine("g", "Hello world")]).size).toBe(0);
  });
  it("the read arriving BEFORE the send answer: the bubble is shown while sending, then hidden the moment the answer carries the id", async () => {
    reply = "hang";
    const view = render(<Chat shown={[]} />);
    type("early");
    await press();
    const early = mine("g7", "early", new Date(Date.now() + 1000).toISOString());
    view.rerender(<Chat shown={[early]} />);
    expect(stateOf()).toEqual(["sending"]); // not hidden: it is still being sent
    reply = { status: 200, body: { ok: true, state: "sent", messageId: "g7" } };
    await act(async () => release?.());
    await settle();
    expect(screen.queryAllByTestId("send-item")).toHaveLength(0);
  });
  it("two sends of 'ok' in a row are two bubbles until Teams shows two messages", async () => {
    const view = render(<Chat shown={[]} />);
    for (const id of ["g1", "g2"]) {
      reply = { status: 200, body: { ok: true, state: "sent", messageId: id } };
      type("ok");
      await press();
    }
    expect(screen.getAllByTestId("send-item")).toHaveLength(2);
    view.rerender(<Chat shown={[mine("g1", "ok", new Date(Date.now() + 1000).toISOString())]} />);
    expect(screen.getAllByTestId("send-item")).toHaveLength(1);
    view.rerender(<Chat shown={[mine("g1", "ok", new Date(Date.now() + 1000).toISOString()), mine("g2", "ok", new Date(Date.now() + 2000).toISOString())]} />);
    expect(screen.queryAllByTestId("send-item")).toHaveLength(0);
  });
});

const R = (status: number, body: unknown): Reply => ({ status, body });
const SENT = R(200, { ok: true, state: "sent", messageId: "g1" });
const ids = () => requests.map((r) => r.body.clientRequestId);
const markerKey = `nichols:teams-send:PKG:${USER}:${CONN}:${KEY}`;

describe("T-288 review A: the request id belongs to the text, and an in-flight marker survives leaving the chat", () => {
  it("a 429, a gate refusal and a 503 unavailable KEEP the id: the next press with the same text is the same action; a CHANGED text is a new id; a confirmed terminal outcome is a new id", async () => {
    render(composer());
    type("same words");
    for (const r of [R(429, { error: "rate_limited" }), R(409, { error: "gate_not_live" }), R(503, { error: "unavailable" })]) {
      reply = r;
      await press();
    }
    reply = SENT;
    await press();
    expect(new Set(ids()).size).toBe(1);
    expect(requests).toHaveLength(4);
    type("next message");
    await press();
    expect(new Set(ids()).size).toBe(2); // the sent one was terminal: a new message, a new id
    reply = R(429, { error: "rate_limited" });
    type("first text");
    await press();
    type("first text, edited");
    await press();
    expect(new Set(ids()).size).toBe(4); // edited after a refusal: a new id
  });

  it("an unknown outcome keeps the id for that text: retyping the same text asks about the SAME action, it can never be a second post", async () => {
    reply = R(502, { error: "unknown_outcome" });
    render(composer());
    type("maybe");
    await press();
    expect(stateOf()).toEqual(["unknown"]);
    type("maybe");
    reply = SENT;
    await press();
    expect(new Set(ids()).size).toBe(1);
  });

  it("the marker is in the tab's storage BEFORE the request leaves (id, hash of the text, start time) and gone once a confirmed answer arrived", async () => {
    let seen: string | null = null;
    atRequest = () => void (seen = window.sessionStorage.getItem(markerKey));
    render(composer());
    type("persisted");
    await press();
    const m = JSON.parse(seen ?? "null") as { d: { list: { id: string; hash: string; text: string; startedAt: number; state: string }[] } };
    expect(m.d.list[0]).toMatchObject({ id: requests[0]?.body.clientRequestId, hash: requests[0]?.body.textSha256, text: "persisted", state: "inflight" });
    expect(typeof m.d.list[0]?.startedAt).toBe("number");
    expect(window.sessionStorage.getItem(markerKey)).toBeNull();
  });

  it("LEAVE AND RETURN MID-SEND: the chat is left, then opened again: the message shows as 'may have been sent' with Send-if-not-sent and Dismiss; the text is NOT put back in the box", async () => {
    reply = "hang";
    render(composer());
    type("mid flight");
    await press();
    cleanup(); // the person left the chat; the request is still open
    expect(window.sessionStorage.getItem(markerKey)).not.toBeNull();
    render(composer());
    await settle();
    expect(stateOf()).toEqual(["unknown"]);
    expect(screen.getByTestId("send-state").textContent).toContain("This message may have been sent. Look at the chat in Teams first.");
    expect(screen.getByTestId("send-text").textContent).toBe("mid flight");
    expect(screen.getByTestId("send-if-not-sent")).toBeTruthy();
    expect(screen.getByTestId("send-dismiss")).toBeTruthy();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("");
  });

  it("RELOAD MID-SEND: a fresh page with the marker in the tab shows the same; nothing is sent by merely opening it", async () => {
    window.sessionStorage.setItem(markerKey, JSON.stringify({ v: 1, t: Date.now(), d: { list: [{ id: "5e11d0c0-0000-4000-8000-000000000009", hash: "a".repeat(64), text: "before reload", startedAt: Date.now(), state: "inflight", messageId: null, reason: null, dismissed: false }] } }));
    render(composer());
    await settle();
    expect(stateOf()).toEqual(["unknown"]);
    expect(requests).toHaveLength(0);
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("");
  });

  it("a LATE answer that arrives while the person is away updates the stored marker, so the right state shows on return (sent here)", async () => {
    reply = "hang";
    render(composer());
    type("late answer");
    await press();
    cleanup();
    reply = SENT;
    await act(async () => release?.());
    await settle();
    render(composer());
    await settle();
    expect(stateOf()).toEqual(["sent"]);
    expect(window.sessionStorage.getItem(markerKey)).toBeNull();
  });

  it("a late answer that arrives AFTER the person came back updates the bubble in place (the open composer hears it)", async () => {
    reply = "hang";
    render(composer());
    type("later still");
    await press();
    cleanup();
    render(composer());
    await settle();
    expect(stateOf()).toEqual(["unknown"]);
    reply = SENT;
    await act(async () => release?.());
    await settle();
    expect(stateOf()).toEqual(["sent"]);
  });

  it("a late definite 'not sent' brings the text back into an EMPTY box, with the reason", async () => {
    reply = "hang";
    render(composer());
    type("not delivered");
    await press();
    cleanup();
    reply = R(200, { ok: true, state: "not_sent", code: "not_a_member", message: "You are not a member of this chat or channel, or sending is not allowed" });
    await act(async () => release?.());
    await settle();
    render(composer());
    await settle();
    expect(stateOf()).toEqual(["not_sent"]);
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("not delivered");
  });

  it.each([
    ["sent", SENT, "sent"],
    ["checking", R(200, { ok: true, state: "checking" }), "checking"],
    ["still unknown (the server cannot tell yet)", R(200, { ok: true, state: "unknown" }), "unknown"],
    ["unknown outcome", R(502, { error: "unknown_outcome" }), "unknown"],
    ["failed with a definite reason", R(200, { ok: true, state: "not_sent", code: "send_rejected", message: "Teams did not accept this message, so nothing was sent" }), "not_sent"],
    ["a dropped connection", "throw" as Reply, "unknown"],
  ])("Send if it has not been sent, the server says: %s: the SAME id and the SAME text are asked again, never a different message", async (_n, answer, state) => {
    window.sessionStorage.setItem(markerKey, JSON.stringify({ v: 1, t: Date.now(), d: { list: [{ id: "5e11d0c0-0000-4000-8000-000000000009", hash: await sendTextHash("check me"), text: "check me", startedAt: Date.now(), state: "inflight", messageId: null, reason: null, dismissed: false }] } }));
    render(composer());
    await settle();
    reply = answer;
    await act(async () => void fireEvent.click(screen.getByTestId("send-if-not-sent")));
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ clientRequestId: "5e11d0c0-0000-4000-8000-000000000009", text: "check me", textSha256: await sendTextHash("check me"), conn: CONN, chat: KEY });
    expect(stateOf()).toEqual([state]);
  });

  it("Dismiss keeps the marker (so the id is kept) and removes the actions; the text stays on the page to copy; nothing is sent", async () => {
    window.sessionStorage.setItem(markerKey, JSON.stringify({ v: 1, t: Date.now(), d: { list: [{ id: "5e11d0c0-0000-4000-8000-000000000009", hash: "a".repeat(64), text: "keep to copy", startedAt: Date.now(), state: "unknown", messageId: null, reason: null, dismissed: false }] } }));
    render(composer());
    await settle();
    await act(async () => void fireEvent.click(screen.getByTestId("send-dismiss")));
    expect(JSON.parse(window.sessionStorage.getItem(markerKey) ?? "null").d.list[0]).toMatchObject({ dismissed: true }); // the id is kept for that exact text
    expect(screen.queryByTestId("send-actions")).toBeNull();
    expect(screen.getByTestId("send-text").textContent).toBe("keep to copy");
    expect(requests).toHaveLength(0);
  });

  it("the marker is per conversation: another chat or another person never sees it", async () => {
    window.sessionStorage.setItem(markerKey, JSON.stringify({ v: 1, t: Date.now(), d: { list: [{ id: "5e11d0c0-0000-4000-8000-000000000009", hash: "a".repeat(64), text: "mine", startedAt: Date.now(), state: "unknown", messageId: null, reason: null, dismissed: false }] } }));
    render(<Chat conn="00000000-0000-4000-8000-0000000000c2" />);
    await settle();
    expect(screen.queryAllByTestId("send-item")).toHaveLength(0);
    cleanup();
    render(<Chat user="00000000-0000-4000-8000-0000000000bb" />);
    await settle();
    expect(screen.queryAllByTestId("send-item")).toHaveLength(0);
  });

  it("C7: another person signing in in this tab clears the previous person's copies and markers before anything is read", async () => {
    window.sessionStorage.setItem("nichols:last-user", "00000000-0000-4000-8000-0000000000bb");
    const other = `nichols:teams-send:PKG:00000000-0000-4000-8000-0000000000bb:${CONN}:${KEY}`;
    window.sessionStorage.setItem(other, "{}");
    window.sessionStorage.setItem(`nichols:teams-draft:PKG:00000000-0000-4000-8000-0000000000bb:${CONN}:${KEY}`, "{}");
    render(composer());
    await settle();
    expect(window.sessionStorage.getItem(other)).toBeNull();
    expect(window.sessionStorage.getItem("nichols:last-user")).toBe(USER);
  });
});

const seed = (over: Record<string, unknown> = {}, item = `${CONN}:${KEY}`) =>
  window.sessionStorage.setItem(`nichols:teams-send:PKG:${USER}:${item}`, JSON.stringify({ v: 1, t: Date.now(), d: { list: [{ id: "5e11d0c0-0000-4000-8000-000000000009", hash: "a".repeat(64), text: "unsure", startedAt: Date.now(), state: "unknown", messageId: null, reason: null, dismissed: false, ...over }] } }));
const markerList = () => (JSON.parse(window.sessionStorage.getItem(markerKey) ?? "null")?.d?.list ?? []) as { id: string; state: string; dismissed: boolean; text: string; hash: string }[];
const OLD = "5e11d0c0-0000-4000-8000-000000000009";

describe("T-288 re-check 1: a refusal answered to a REPLAY is not 'Not sent'", () => {
  it.each([
    ["429 rate limited", R(429, { error: "rate_limited" }), /wait a second and try again/],
    ["a stale authenticator code", R(403, { error: "step_up_required" }), /authenticator code to check/],
    ["reconnect", R(409, { error: "reconnect" }), /Reconnect Teams to check/],
    ["a gate closed", R(409, { error: "gate_not_live" }), /Approvals are not live for this company yet\./],
    ["the role was removed", R(403, { error: "forbidden" }), /You can no longer send from this account\./],
    ["a 503 unavailable", R(503, { error: "unavailable" }), /Could not check just now/],
    ["not found", R(404, { error: "not_found" }), /This chat or account is no longer available here\./],
  ])("%s on a replay: the message stays 'may have been sent', the marker stays, the reason is a note, nothing is restored into the box", async (_n, answer, note) => {
    seed();
    render(composer());
    await settle();
    reply = answer;
    await act(async () => void fireEvent.click(screen.getByTestId("send-if-not-sent")));
    await settle();
    expect(stateOf()).toEqual(["unknown"]);
    expect(screen.getByTestId("send-state").textContent).not.toContain("Not sent");
    expect(screen.getByTestId("send-note").textContent).toMatch(note);
    expect(screen.getByTestId("send-state").textContent).toBe("?This message may have been sent. Look at the chat in Teams first.");
    expect(markerList().map((m) => m.id)).toEqual([OLD]);
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByTestId("send-if-not-sent")).toBeTruthy(); // still offered: asking again is safe
  });

  it("a stale code on a replay keeps the bubble and the marker and goes to the authenticator page; 'could not be kept' never appears (the text is in the marker)", async () => {
    seed();
    render(composer());
    await settle();
    reply = R(403, { error: "step_up_required" });
    await act(async () => void fireEvent.click(screen.getByTestId("send-if-not-sent")));
    await settle();
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(String(nav.push.mock.calls[0]?.[0])).toMatch(/^\/mfa\?reauth=1&next=/);
    expect(markerList()).toHaveLength(1);
    expect(stateOf()).toEqual(["unknown"]);
    expect(screen.getByTestId("composer-note").textContent).not.toMatch(/could not be kept/);
    cleanup(); // back from the authenticator page
    render(composer());
    await settle();
    expect(stateOf()).toEqual(["unknown"]);
    expect(screen.getByTestId("send-if-not-sent")).toBeTruthy();
  });

  it("the same refusals on a FIRST submit are still 'Not sent' (nothing was sent)", async () => {
    for (const answer of [R(429, { error: "rate_limited" }), R(409, { error: "gate_not_live" }), R(409, { error: "reconnect" }), R(503, { error: "unavailable" })]) {
      reply = answer;
      render(composer());
      type("first time");
      await press();
      expect(stateOf()).toEqual(["not_sent"]);
      expect(markerList()).toHaveLength(0);
      cleanup();
      window.sessionStorage.clear();
    }
  });

  it("a refusal after an UNKNOWN outcome in the same page (no reload) is a replay too: 429 does not turn 'may have been sent' into 'Not sent'", async () => {
    reply = R(502, { error: "unknown_outcome" });
    render(composer());
    type("same text");
    await press();
    reply = R(429, { error: "rate_limited" });
    type("same text");
    await press();
    expect(stateOf()).toEqual(["unknown"]);
    expect(new Set(ids()).size).toBe(1);
    expect(markerList()).toHaveLength(1);
  });

  it("a refusal the route marks `fresh` (its proposal was rejected on the spot) and a server 'failed' are definite even for a replay; the next press has a NEW id", async () => {
    seed({ text: "retry me" });
    render(composer());
    await settle();
    reply = R(503, { error: "unavailable", fresh: true });
    await act(async () => void fireEvent.click(screen.getByTestId("send-if-not-sent")));
    await settle();
    expect(stateOf()).toEqual(["not_sent"]);
    expect(markerList()).toHaveLength(0);
    reply = SENT;
    type("retry me");
    await press();
    expect(ids()[1]).not.toBe(ids()[0]);
    // a step-up answer with `fresh` renews the id as well
    cleanup();
    window.sessionStorage.clear();
    seed({ text: "again" });
    render(composer());
    await settle();
    reply = R(403, { error: "step_up_required", fresh: true });
    await act(async () => void fireEvent.click(screen.getByTestId("send-if-not-sent")));
    await settle();
    expect(markerList()).toHaveLength(0);
    reply = SENT;
    type("again");
    await press();
    expect(ids().at(-1)).not.toBe(OLD);
  });

  it("typing while a replay is in flight: the text typed meanwhile stays in the box, and the answer does not erase it", async () => {
    seed();
    render(composer());
    await settle();
    reply = "hang";
    await act(async () => void fireEvent.click(screen.getByTestId("send-if-not-sent")));
    type("typed during the replay");
    reply = SENT;
    await act(async () => release?.());
    await settle();
    expect(stateOf()).toEqual(["sent"]);
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("typed during the replay");
  });
});

describe("T-288 re-check 2: one record per message", () => {
  it("reload -> Send if it has not been sent -> Sent -> leave -> return: the box is empty and nothing is restored", async () => {
    seed();
    teamsDrafts.write("PKG", USER, `${CONN}:${KEY}`, { text: "unsure" }); // an old copy of the same text
    render(composer());
    await settle();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe(""); // a draft whose text has a marker is never restored
    reply = SENT;
    await act(async () => void fireEvent.click(screen.getByTestId("send-if-not-sent")));
    await settle();
    expect(stateOf()).toEqual(["sent"]);
    cleanup();
    render(composer());
    await settle();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryAllByTestId("send-item")).toHaveLength(0);
    expect(teamsDrafts.read("PKG", USER, `${CONN}:${KEY}`)).toBeNull();
  });

  it("Dismiss -> reload: the box is empty, a closed bubble shows its note and no actions; retyping the SAME text replays the SAME id (one action, never a second post)", async () => {
    seed();
    render(composer());
    await settle();
    await act(async () => void fireEvent.click(screen.getByTestId("send-dismiss")));
    cleanup();
    render(composer());
    await settle();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByTestId("send-item").getAttribute("data-closed")).toBe("true");
    expect(screen.queryByTestId("send-actions")).toBeNull();
    expect(screen.getByTestId("send-note").textContent).toMatch(/never sent twice/);
    reply = SENT;
    type("unsure");
    await press();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.clientRequestId).toBe(OLD);
    expect(stateOf()).toEqual(["sent"]);
    expect(markerList()).toHaveLength(0);
  });

  it("an unknown outcome for X survives sending a different message Y and a reload; the list is capped", async () => {
    reply = R(502, { error: "unknown_outcome" });
    render(composer());
    type("message X");
    await press();
    reply = SENT;
    type("message Y");
    await press();
    expect(markerList().map((m) => m.state)).toEqual(["unknown"]);
    cleanup();
    render(composer());
    await settle();
    expect(screen.getAllByTestId("send-item")).toHaveLength(1);
    expect(screen.getByTestId("send-text").textContent).toBe("message X");
    expect(stateOf()).toEqual(["unknown"]);
    cleanup();
    window.sessionStorage.clear();
    requests = [];
    reply = R(502, { error: "unknown_outcome" });
    render(composer());
    for (let n = 0; n < 5; n++) {
      type(`unsure ${n}`);
      await press();
    }
    expect(markerList()).toHaveLength(5);
    // a sixth unresolved message is NOT sent: the oldest is never evicted to make room; the text stays in the box
    type("one too many");
    await press();
    expect(requests).toHaveLength(5);
    expect(markerList()).toHaveLength(5);
    expect(screen.getByTestId("composer-note").textContent).toBe("Look at the earlier messages in Teams first, then dismiss them here.");
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("one too many");
    // a dismissed one makes room (dismissed records are evicted first)
    await act(async () => void fireEvent.click(screen.getAllByTestId("send-dismiss")[0] as HTMLElement));
    await press();
    expect(requests).toHaveLength(6); // four unresolved now: it goes, and the dismissed record made room
    expect(markerList()).toHaveLength(5);
    expect(markerList().some((m) => m.dismissed)).toBe(false);
  });
});

describe("T-288 re-check 3: wording and the two actions", () => {
  it("the unknown bubble has ONE state line and at most one note: the state line is never repeated after a colon", async () => {
    reply = "throw";
    render(composer());
    type("no answer");
    await press();
    const state = screen.getByTestId("send-state").textContent ?? "";
    expect(state).toBe("?This message may have been sent. Look at the chat in Teams first.");
    expect(state.match(/may have been sent/g)).toHaveLength(1);
    expect(screen.getByTestId("send-note").textContent).toBe("The portal got no answer, so it cannot tell.");
    expect(screen.getByTestId("send-if-not-sent").textContent).toBe("Send if it has not been sent");
    expect(screen.getByTestId("send-dismiss").textContent).toBe("Dismiss");
  });

  it("unknown -> Dismiss -> retype the same text -> Send: the server answers the OLD action's state: ONE id, and when the server says it was sent there is one POST in total", async () => {
    reply = R(502, { error: "unknown_outcome" });
    render(composer());
    type("do not double");
    await press();
    await act(async () => void fireEvent.click(screen.getByTestId("send-dismiss")));
    reply = SENT;
    type("do not double");
    await press();
    expect(new Set(ids()).size).toBe(1);
    expect(requests).toHaveLength(2);
    expect(stateOf()).toEqual(["sent"]);
  });

  it("a record is offered 'Send if it has not been sent' for its WHOLE life (there is no separate 'older than an hour' state): 90 minutes old still has the action and a retyped text reuses the id", async () => {
    seed({ startedAt: Date.now() - 90 * 60_000 });
    render(composer());
    await settle();
    expect(screen.getByTestId("send-state").textContent).toBe("?This message may have been sent. Look at the chat in Teams first.");
    expect(screen.getByTestId("send-if-not-sent")).toBeTruthy();
    expect(screen.getByTestId("send-safe").textContent).toBe("Safe to press: the portal sends this message at most once.");
    reply = R(200, { ok: true, state: "not_sent", code: "expired", message: "This message expired before it was sent, so nothing was sent. Send it again" });
    type("unsure");
    await press();
    expect(requests[0]?.body.clientRequestId).toBe(OLD);
    expect(stateOf()).toEqual(["not_sent"]); // the server says a replay of an expired action failed: a definite refusal, and the next press has a new id
  });

  it("request_reused is not a dead end: it is Not sent with its own sentence and the next press has a new id", async () => {
    reply = R(409, { error: "request_reused" });
    render(composer());
    type("reused");
    await press();
    expect(stateOf()).toEqual(["not_sent"]);
    reply = SENT;
    await press();
    expect(ids()[1]).not.toBe(ids()[0]);
  });
});

describe("T-288 re-check 4 and 5: layout, and nothing kept when sending is off", () => {
  it("with more than one account the short label stays visible while the box has focus on a phone; with one account there is none", () => {
    const { rerender } = render(<SendScope laneId="PKG" conn={CONN} chatKey={KEY} userId={USER} enabled><Composer laneId="PKG" conn={CONN} chatKey={KEY} account={ACCOUNT} accountLabel="pubkgroup.com" userId={USER} /></SendScope>);
    const short = screen.getByTestId("composer-line-short");
    expect(short.textContent).toBe("As pubkgroup.com");
    expect(short.className).toContain("group-data-[focused=true]/composer:max-lg:inline");
    expect(short.className).toContain("truncate");
    rerender(<SendScope laneId="PKG" conn={CONN} chatKey={KEY} userId={USER} enabled><Composer laneId="PKG" conn={CONN} chatKey={KEY} account={ACCOUNT} userId={USER} /></SendScope>);
    expect(screen.queryByTestId("composer-line-short")).toBeNull();
  });

  it("when the box grows and the list was at the bottom, the list is pinned to the bottom again; when it was not, it is left alone", () => {
    const sh = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(120);
    try {
      render(
        <div data-testid="conversation">
          <div data-testid="conversation-scroll" />
          {composer()}
        </div>,
      );
      const scroller = screen.getByTestId("conversation-scroll");
      const geometry = (top: number, client = 100) => {
        Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 500 });
        Object.defineProperty(scroller, "clientHeight", { configurable: true, value: client });
        scroller.scrollTop = top;
        scroller.dispatchEvent(new Event("scroll")); // the remembered "at the bottom" comes from the list's own scroll events
      };
      geometry(400); // at the bottom
      type("one\ntwo\nthree");
      expect(scroller.scrollTop).toBe(500);
      geometry(100); // reading older messages
      type("one\ntwo\nthree\nfour");
      expect(scroller.scrollTop).toBe(100);
    } finally {
      sh.mockRestore();
    }
  });

  it("the box is fitted again when the pane's height changes (the keyboard opening), not only on a keystroke", () => {
    let callback: (() => void) | null = null;
    let paneHeight = 600;
    vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { callback = cb; } observe() {} disconnect() {} });
    const sh = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(60);
    const ch = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("data-testid") === "conversation" ? paneHeight : 0;
    });
    try {
      render(<div data-testid="conversation">{composer()}</div>);
      sh.mockReturnValue(1000);
      type("x\n".repeat(30));
      const el = screen.getByTestId("composer-text") as HTMLTextAreaElement;
      expect(el.style.height).toBe("176px"); // 8 lines at the 22 px default of jsdom; a third of the 600 px pane (200) is not the limit
      paneHeight = 120; // the keyboard is up: a third of the pane is 40 px (never below one line, 44)
      act(() => void callback?.());
      expect(el.style.height).toBe("44px");
    } finally {
      sh.mockRestore();
      ch.mockRestore();
      vi.unstubAllGlobals();
      vi.stubGlobal("fetch", fetchMock);
    }
  });

  it.each([
    ["lane_off", "keep_text", "unsure"],
    ["policy_off", "keep_text", "unsure"],
    ["drafts_off", "strip_text", ""],
  ] as const)("sending switched off (%s): unsent copies go, the records of unresolved messages STAY as plain warnings (text %s), another person's and another lane's are untouched; Dismiss removes one", async (_n, mode, kept) => {
    seed(); // unknown
    teamsDrafts.write("PKG", USER, `${CONN}:${KEY}`, { text: "a copy" });
    const other = "00000000-0000-4000-8000-0000000000bb";
    window.sessionStorage.setItem(`nichols:teams-send:PKG:${other}:x`, "{}");
    window.sessionStorage.setItem(`nichols:teams-draft:OTHERLANE:${USER}:x`, "{}");
    render(<SendScope laneId="PKG" conn={CONN} chatKey={KEY} userId={USER} enabled={false} clear={mode}><ul><PendingBubbles shown={[]} /></ul></SendScope>);
    await settle();
    expect(teamsDrafts.read("PKG", USER, `${CONN}:${KEY}`)).toBeNull();
    expect(markerList()).toHaveLength(1);
    expect(markerList()[0]).toMatchObject({ id: OLD, text: kept, hash: "a".repeat(64), state: "unknown" });
    expect(screen.getByTestId("send-state").textContent).toBe("?A message you sent earlier may have been sent. Look at the chat in Teams.");
    expect(screen.queryByTestId("send-if-not-sent")).toBeNull();
    expect(screen.getByTestId("send-dismiss")).toBeTruthy();
    expect(window.sessionStorage.getItem(`nichols:teams-send:PKG:${other}:x`)).not.toBeNull();
    expect(window.sessionStorage.getItem(`nichols:teams-draft:OTHERLANE:${USER}:x`)).not.toBeNull();
    await act(async () => void fireEvent.click(screen.getByTestId("send-dismiss")));
    expect(markerList()).toHaveLength(0);
    expect(screen.queryAllByTestId("send-item")).toHaveLength(0);
  });

  it("sending switched off: an in-flight and a dismissed record stay too, a resolved one (sent) goes", async () => {
    window.sessionStorage.setItem(markerKey, JSON.stringify({ v: 1, t: Date.now(), d: { list: [
      { id: "5e11d0c0-0000-4000-8000-00000000000a", hash: "b".repeat(64), text: "x", startedAt: Date.now(), state: "inflight", messageId: null, reason: null, dismissed: false },
      { id: "5e11d0c0-0000-4000-8000-00000000000b", hash: "c".repeat(64), text: "y", startedAt: Date.now(), state: "unknown", messageId: null, reason: null, dismissed: true },
      { id: "5e11d0c0-0000-4000-8000-00000000000c", hash: "d".repeat(64), text: "z", startedAt: Date.now(), state: "sent", messageId: "g", reason: null, dismissed: false },
    ] } }));
    render(<SendScope laneId="PKG" conn={CONN} chatKey={KEY} userId={USER} enabled={false} clear="strip_text"><ul><PendingBubbles shown={[]} /></ul></SendScope>);
    await settle();
    expect(markerList().map((m) => m.id.slice(-1))).toEqual(["a", "b"]);
    expect(markerList().every((m) => m.text === "")).toBe(true);
  });
});

describe("T-288 second re-check", () => {
  it("R1: when the tab's storage refuses the marker and the answer is lost, retyping the same text in the open page REUSES the id; the bubble says the warning cannot be kept", async () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      reply = "throw";
      render(composer());
      type("no storage");
      await press();
      expect(screen.getByTestId("send-note").textContent).toContain("This warning cannot be kept if you reload: look at the chat in Teams before reloading.");
      reply = SENT;
      type("no storage");
      await press();
      expect(new Set(ids()).size).toBe(1);
      // and after Dismiss as well
    } finally {
      Storage.prototype.setItem = orig;
    }
  });

  it("R1: the same after Dismiss with no storage", async () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      reply = R(502, { error: "unknown_outcome" });
      render(composer());
      type("dismissed text");
      await press();
      await act(async () => void fireEvent.click(screen.getByTestId("send-dismiss")));
      reply = SENT;
      type("dismissed text");
      await press();
      expect(new Set(ids()).size).toBe(1);
    } finally {
      Storage.prototype.setItem = orig;
    }
  });

  it("P1: retyping a dismissed message whose replay says it WAS sent shows 'Sent earlier' (nothing new was sent) and KEEPS the text in the box; a deliberate second press is a NEW message with a new id", async () => {
    reply = R(502, { error: "unknown_outcome" });
    render(composer());
    type("did it go");
    await press();
    await act(async () => void fireEvent.click(screen.getByTestId("send-dismiss")));
    reply = SENT;
    type("did it go");
    await press();
    expect(screen.getByTestId("send-state").textContent).toBe("✓Sent earlier: this is the message from before, nothing new was sent.");
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("did it go");
    await press();
    expect(requests).toHaveLength(3);
    expect(ids()[2]).not.toBe(ids()[0]);
  });

  it("P5: a held Ctrl+Enter while a send is open does not save the box text as a draft", async () => {
    reply = "hang";
    render(composer());
    type("held key");
    await press();
    teamsDrafts.remove("PKG", USER, `${CONN}:${KEY}`);
    type("more");
    await act(async () => void fireEvent.keyDown(screen.getByTestId("composer-text"), { key: "Enter", ctrlKey: true }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 600))));
    expect(requests).toHaveLength(1);
    expect(teamsDrafts.read("PKG", USER, `${CONN}:${KEY}`)).toEqual({ text: "more" }); // only the typing's own debounced copy; the held key added nothing
    reply = SENT;
    await act(async () => release?.());
  });

  it("P6: a replay that ends in a definite 'not sent' puts the text back into an EMPTY box; the bubble stays until dismissed, and survives the next press", async () => {
    seed({ text: "come back" });
    render(composer());
    await settle();
    reply = R(200, { ok: true, state: "not_sent", code: "not_a_member", message: "You are not a member of this chat or channel, or sending is not allowed", fresh: true });
    await act(async () => void fireEvent.click(screen.getByTestId("send-if-not-sent")));
    await settle();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("come back");
    expect(screen.getByTestId("send-dismiss")).toBeTruthy();
    reply = SENT;
    await press();
    expect(stateOf()).toContain("not_sent"); // the replay's bubble was not swept away by the next press
    await act(async () => void fireEvent.click(screen.getAllByTestId("send-dismiss")[0] as HTMLElement));
    expect(screen.queryAllByTestId("send-item").some((i) => i.getAttribute("data-state") === "not_sent")).toBe(false);
  });

  it("P2: the list stays pinned when the pane shrinks BEFORE the observer fires (the keyboard): 'at the bottom' is remembered from the last scroll, not measured late", () => {
    let callback: (() => void) | null = null;
    vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { callback = cb; } observe() {} disconnect() {} });
    try {
      render(
        <div data-testid="conversation">
          <div data-testid="conversation-scroll" />
          {composer()}
        </div>,
      );
      const scroller = screen.getByTestId("conversation-scroll");
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 500 });
      Object.defineProperty(scroller, "clientHeight", { configurable: true, writable: true, value: 100 });
      scroller.scrollTop = 400;
      scroller.dispatchEvent(new Event("scroll")); // at the bottom
      Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 10 }); // the pane shrank first: measured now, 500 - 400 - 10 = 90... made larger below
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 700 }); // measured late it is 290 from the bottom: "not at the bottom"
      act(() => void callback?.());
      expect(scroller.scrollTop).toBe(700);
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("fetch", fetchMock);
    }
  });
});

describe("T-288 review B: Not sent only when nothing was sent", () => {
  it("classifyAnswer: only the route's own JSON with a known code is a refusal; everything else is Outcome unknown", () => {
    expect(classifyAnswer(429, { error: "rate_limited" })).toMatchObject({ kind: "refused" });
    expect(classifyAnswer(409, { error: "gate_not_live" })).toMatchObject({ kind: "refused" });
    expect(classifyAnswer(503, { error: "unavailable" })).toMatchObject({ kind: "refused" });
    expect(classifyAnswer(403, { error: "step_up_required" })).toEqual({ kind: "stepup", fresh: false });
    expect(classifyAnswer(403, { error: "step_up_required", fresh: true })).toEqual({ kind: "stepup", fresh: true });
    expect(classifyAnswer(409, { error: "request_reused" })).toMatchObject({ kind: "refused", fresh: true });
    for (const [status, body] of [[500, null], [502, null], [503, null], [504, "<html>"], [500, { error: "unavailable" }], [502, { error: "unknown_outcome" }], [500, { error: "gate_not_live" }], [409, { error: "something_new" }], [200, { nope: 1 }], [200, { ok: true, state: "mystery" }], [404, undefined]] as [number, unknown][]) {
      expect(classifyAnswer(status, body).kind, `${status} ${JSON.stringify(body)}`).toBe("unknown");
    }
  });

  it.each([
    ["a platform 500 with an HTML body", { status: 500, raw: "<html>Internal Server Error</html>" } as Reply, "unknown", true],
    ["a 503 with an HTML body", { status: 503, raw: "<html>Service Unavailable</html>" } as Reply, "unknown", true],
    ["the route's own JSON 503 unavailable (a read failed before anything was proposed)", R(503, { error: "unavailable" }), "not_sent", false],
    ["a dropped connection", "throw" as Reply, "unknown", true],
    ["a 502 unknown_outcome", R(502, { error: "unknown_outcome" }), "unknown", true],
    ["a pre-propose database error the route answers as 503 unavailable", R(503, { error: "unavailable", fresh: false }), "not_sent", false],
  ])("%s: %s", async (_n, answer, state, cleared) => {
    reply = answer;
    render(composer());
    type("classified");
    await press();
    expect(stateOf()).toEqual([state]);
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe(cleared ? "" : "classified");
  });

  it("a refusal that says `fresh` (its proposal was rejected on the spot) makes the next press a NEW id", async () => {
    render(composer());
    type("fresh");
    reply = R(403, { error: "step_up_required", fresh: true });
    await press(); // the step-up branch: no id change here (the route stopped before proposing); only gates after a reject say fresh
    reply = R(503, { error: "unavailable", fresh: true });
    await press();
    reply = SENT;
    await press();
    expect(ids()[2]).not.toBe(ids()[1]);
  });
});

describe("T-288 review C: the composer's behaviour", () => {
  it("C1: text typed while a send is open stays in the box (and its copy) when the answer arrives; the box is emptied only when it still holds exactly what was sent", async () => {
    reply = "hang";
    render(composer());
    type("first");
    await press();
    expect(screen.getByTestId("composer-text").hasAttribute("disabled")).toBe(false); // editable while sending
    type("first, then more");
    reply = SENT;
    await act(async () => release?.());
    await settle();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("first, then more");
    await act(async () => void (await new Promise((r) => setTimeout(r, 600)))); // the debounced copy
    expect(teamsDrafts.read("PKG", USER, `${CONN}:${KEY}`)).toEqual({ text: "first, then more" });
  });

  it("C5: when the tab copy cannot be saved, the person is NOT sent away and the text stays; the note says so", async () => {
    reply = R(403, { error: "step_up_required" });
    render(composer());
    type("cannot keep");
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      await press();
    } finally {
      Storage.prototype.setItem = orig;
    }
    expect(nav.push).not.toHaveBeenCalled();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("cannot keep");
    expect(screen.getByTestId("composer-note").textContent).toMatch(/could not be kept/);
  });

  it("C5: a lost sign-in (401) or a missing authenticator level (mfa_required) offers the sign-in step, not 'could not send just now'", async () => {
    reply = R(401, { error: "no_session" });
    render(composer());
    type("signed out");
    await press();
    expect(screen.getByTestId("composer-note").textContent).toMatch(/sign-in ended/);
    expect(screen.getByTestId("composer-note").querySelector("a")?.getAttribute("href")).toBe("/sign-in");
    reply = R(403, { error: "mfa_required" });
    await press();
    expect(screen.getByTestId("composer-note").querySelector("a")?.getAttribute("href")).toBe("/mfa");
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("signed out");
  });

  it("C6: Ctrl+Enter while an input method is composing is ignored; a lone surrogate is refused with the server's own sentence; the problem line is in a live region", async () => {
    render(composer());
    type("composing");
    await act(async () => void fireEvent.keyDown(screen.getByTestId("composer-text"), { key: "Enter", ctrlKey: true, isComposing: true }));
    await settle();
    expect(requests).toHaveLength(0);
    type("bad \ud800 text");
    expect(screen.getByTestId("composer-problem").textContent).toBe("The message holds an invalid character");
    expect(screen.getByTestId("composer-problem-region").getAttribute("aria-live")).toBe("polite");
    await press();
    expect(requests).toHaveLength(0);
  });

  it("C6: the same words twice in a row are made different (a zero-width mark toggles), so a screen reader says them again; different words are left alone", () => {
    expect(nextAnnounce("", "Sent")).toBe("Sent");
    const second = nextAnnounce("Sent", "Sent");
    expect(second).not.toBe("Sent");
    expect(second.replaceAll("\u200b", "")).toBe("Sent");
    expect(nextAnnounce(second, "Sent")).toBe("Sent");
    expect(nextAnnounce("Sent", "Not sent")).toBe("Not sent");
  });

  it("C6: a bubble that is still being sent has no time to toggle", async () => {
    reply = "hang";
    render(composer());
    type("no time");
    await press();
    expect(screen.getByTestId("bubble").getAttribute("title")).toBeNull();
    fireEvent.click(screen.getByTestId("bubble"));
    expect(screen.queryByTestId("bubble-time")).toBeNull();
    await act(async () => release?.());
  });

  it("C3: tapping Send does not move the focus (pointer-down is not allowed to), so the phone keyboard stays and the layout stays until the click lands", () => {
    render(composer());
    const btn = screen.getByTestId("composer-send");
    expect(fireEvent.pointerDown(btn)).toBe(false); // preventDefault was called
    expect(fireEvent.mouseDown(btn)).toBe(false);
  });

  it("C3: with the box focused the account line and the times note give way on a phone (classes), and the focus is a data attribute the slot reads", () => {
    render(<ConversationPane view={conv([])} laneId="PKG" connectionId={CONN} send={{ kind: "ready", account: ACCOUNT }} userId={USER} />);
    expect(screen.getByTestId("composer-slot").className).toContain("group/slot");
    expect(screen.getByTestId("times-note").className).toContain("group-has-[[data-focused=true]]/slot:max-lg:hidden");
    expect(screen.getByTestId("composer-line").className).toContain("group-data-[focused=true]/composer:max-lg:sr-only");
    expect(screen.getByTestId("composer").getAttribute("data-focused")).toBe("false");
    act(() => void screen.getByTestId("composer-text").focus());
    expect(screen.getByTestId("composer").getAttribute("data-focused")).toBe("true");
    act(() => void screen.getByTestId("composer-text").blur());
    expect(screen.getByTestId("composer").getAttribute("data-focused")).toBe("false");
    expect(screen.getByTestId("conversation").className).toContain("min-h-[var(--pane-min,16rem)]");
  });

  it.each([
    [1280, 160],
    [375, 100],
  ])("C3: the box grows with its text to about 8 lines on a desktop and 5 on a phone, then scrolls inside (%d px: %d px at a 20 px line)", (w, px) => {
    at(w);
    const lineHeight = vi.spyOn(window, "getComputedStyle").mockReturnValue({ lineHeight: "20px", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" } as never);
    const sh = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
    try {
      render(composer());
      type("a\nb\nc\nd\ne\nf\ng\nh\ni\nj");
      const el = screen.getByTestId("composer-text") as HTMLTextAreaElement;
      expect(el.style.height).toBe(`${px}px`);
      expect(el.style.overflowY).toBe("auto");
      sh.mockReturnValue(30);
      type("short");
      expect(el.style.height).toBe("30px");
      expect(el.style.overflowY).toBe("hidden");
    } finally {
      lineHeight.mockRestore();
      sh.mockRestore();
    }
  });

  it("C3: the box never grows past a third of the pane", () => {
    at(1280);
    const gcs = vi.spyOn(window, "getComputedStyle").mockReturnValue({ lineHeight: "20px", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" } as never);
    const sh = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
    const ch = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("data-testid") === "conversation" ? 240 : 0;
    });
    try {
      render(<div data-testid="conversation">{composer()}</div>);
      type("x\n".repeat(20));
      expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).style.height).toBe("80px"); // 240 / 3
    } finally {
      gcs.mockRestore();
      sh.mockRestore();
      ch.mockRestore();
    }
  });
});

describe("source rules", () => {
  const src = readFileSync(join(__dirname, "messages-send.tsx"), "utf8");
  it("no HTML injection, no localStorage or cookie, no timer, no clock read while rendering, no direct sessionStorage (only the draft store), no Microsoft call", () => {
    expect(src).not.toMatch(/dangerouslySetInnerHTML|localStorage|document\.cookie|setInterval|graph\.microsoft|sessionStorage/);
    // the one clock read is in the press handler
    expect([...src.matchAll(/Date\.now\(\)/g)].length).toBeLessThanOrEqual(8); // handlers and effects only (a render never reads the clock: the lint rule react-hooks/purity)
    expect(normalizeSendText("  a\r\nb  ")).toBe("a\nb");
  });
});
