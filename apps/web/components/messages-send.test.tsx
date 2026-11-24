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
    expect(SEND_STATE_TEXT).toEqual({ sending: "Sending…", sent: "Sent", checking: "Sent, checking…", not_sent: "Not sent", unknown: "Outcome unknown: check the chat in Teams before sending again" });
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
    render(<SendScope><Composer laneId="PKG" conn="00000000-0000-4000-8000-0000000000c2" chatKey={KEY} account="robert@pub-k.org" userId={USER} /></SendScope>);
    await settle();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("");
    cleanup();
    render(<SendScope><Composer laneId="PKG" conn={CONN} chatKey={KEY} account={ACCOUNT} userId="00000000-0000-4000-8000-0000000000bb" /></SendScope>);
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
    const m = JSON.parse(seen ?? "null") as { d: { id: string; hash: string; text: string; startedAt: number; state: string } };
    expect(m.d).toMatchObject({ id: requests[0]?.body.clientRequestId, hash: requests[0]?.body.textSha256, text: "persisted", state: "inflight" });
    expect(typeof m.d.startedAt).toBe("number");
    expect(window.sessionStorage.getItem(markerKey)).toBeNull();
  });

  it("LEAVE AND RETURN MID-SEND: the chat is left, then opened again: the message shows as 'may have been sent' with Check again and Discard; the text is NOT put back in the box", async () => {
    reply = "hang";
    render(composer());
    type("mid flight");
    await press();
    cleanup(); // the person left the chat; the request is still open
    expect(window.sessionStorage.getItem(markerKey)).not.toBeNull();
    render(composer());
    await settle();
    expect(stateOf()).toEqual(["unknown"]);
    expect(screen.getByTestId("send-state").textContent).toContain("This message may have been sent. Check the chat in Teams before sending again.");
    expect(screen.getByTestId("send-text").textContent).toBe("mid flight");
    expect(screen.getByTestId("send-check-again")).toBeTruthy();
    expect(screen.getByTestId("send-discard")).toBeTruthy();
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).value).toBe("");
  });

  it("RELOAD MID-SEND: a fresh page with the marker in the tab shows the same; nothing is sent by merely opening it", async () => {
    window.sessionStorage.setItem(markerKey, JSON.stringify({ v: 1, t: Date.now(), d: { id: "5e11d0c0-0000-4000-8000-000000000009", hash: "a".repeat(64), text: "before reload", startedAt: Date.now(), state: "inflight", messageId: null, reason: null } }));
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
  ])("Check again, the server says: %s: the SAME id and the SAME text are asked again, never a different message", async (_n, answer, state) => {
    window.sessionStorage.setItem(markerKey, JSON.stringify({ v: 1, t: Date.now(), d: { id: "5e11d0c0-0000-4000-8000-000000000009", hash: await sendTextHash("check me"), text: "check me", startedAt: Date.now(), state: "inflight", messageId: null, reason: null } }));
    render(composer());
    await settle();
    reply = answer;
    await act(async () => void fireEvent.click(screen.getByTestId("send-check-again")));
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ clientRequestId: "5e11d0c0-0000-4000-8000-000000000009", text: "check me", textSha256: await sendTextHash("check me"), conn: CONN, chat: KEY });
    expect(stateOf()).toEqual([state]);
  });

  it("Discard removes the marker and the actions; the text stays on the page to copy; nothing is sent", async () => {
    window.sessionStorage.setItem(markerKey, JSON.stringify({ v: 1, t: Date.now(), d: { id: "5e11d0c0-0000-4000-8000-000000000009", hash: "a".repeat(64), text: "keep to copy", startedAt: Date.now(), state: "unknown", messageId: null, reason: null } }));
    render(composer());
    await settle();
    await act(async () => void fireEvent.click(screen.getByTestId("send-discard")));
    expect(window.sessionStorage.getItem(markerKey)).toBeNull();
    expect(screen.queryByTestId("send-actions")).toBeNull();
    expect(screen.getByTestId("send-text").textContent).toBe("keep to copy");
    expect(requests).toHaveLength(0);
  });

  it("the marker is per conversation: another chat or another person never sees it", async () => {
    window.sessionStorage.setItem(markerKey, JSON.stringify({ v: 1, t: Date.now(), d: { id: "5e11d0c0-0000-4000-8000-000000000009", hash: "a".repeat(64), text: "mine", startedAt: Date.now(), state: "unknown", messageId: null, reason: null } }));
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

describe("T-288 review B: Not sent only when nothing was sent", () => {
  it("classifyAnswer: only the route's own JSON with a known code is a refusal; everything else is Outcome unknown", () => {
    expect(classifyAnswer(429, { error: "rate_limited" })).toMatchObject({ kind: "refused" });
    expect(classifyAnswer(409, { error: "gate_not_live" })).toMatchObject({ kind: "refused" });
    expect(classifyAnswer(503, { error: "unavailable" })).toMatchObject({ kind: "refused" });
    expect(classifyAnswer(403, { error: "step_up_required" })).toEqual({ kind: "stepup" });
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
    expect([...src.matchAll(/Date\.now\(\)/g)].length).toBe(2); // the press and Check again: event handlers
    expect(normalizeSendText("  a\r\nb  ")).toBe("a\nb");
  });
});
