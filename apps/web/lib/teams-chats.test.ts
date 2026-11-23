// The chat list and conversation as the page draws them (T-283, T-284): the unread rule with the portal's marker, titles, previews, External, call states, Open in Teams links, failures as fixed
// states, and the privacy rule (a canary in every piece of chat content never reaches a log). The Teams reader is faked (its own tests are in packages/connectors); the pure rules come from the real code.
import { beforeEach, describe, expect, it, vi } from "vitest";

const reader = vi.hoisted(() => ({
  listChats: vi.fn(),
  listMessages: vi.fn(),
  openChat: vi.fn(),
}));
vi.mock("@nichols/connectors/teams-reader", () => ({ listChats: reader.listChats, listMessages: reader.listMessages, openChat: reader.openChat }));

import { chatRow, chatTitle, loadChatList, loadConversation, loadOlder, messageView } from "./teams-chats";
import { encodeChatKey } from "./teams-chat-key";

const CANARY = "canary-chat-content-5d21-not-real";
const CHAT = "19:abc123def456@thread.v2";
const CHAT2 = "19:other456abc@thread.v2";
const ME = "00000000-0000-4000-8000-0000000000a1";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const NOW = Date.parse("2026-11-23T17:00:00Z");

const member = (name: string, over: Partial<{ userId: string | null; external: boolean; self: boolean }> = {}) => ({ userId: null, displayName: name, tenantId: "t", external: false, self: false, ...over });
const chat = (over: Record<string, unknown> = {}) => ({
  chatId: CHAT, chatType: "group", topic: null, webUrl: null, members: [member("Me", { self: true }), member("Pat Example")], membersCapped: false, lastReadAt: "2026-11-20T10:00:00.000Z", hidden: false,
  preview: { createdAt: "2026-11-23T14:05:00.000Z", senderId: U1, senderName: "Pat Example", mine: false, text: "hello there", deleted: false, system: false },
  ...over,
});
const msg = (id: string, at: string, over: Record<string, unknown> = {}) => ({ id, createdAt: at, modifiedAt: at, edited: false, deleted: false, system: false, sender: { id: U1, name: "Pat", kind: "user" }, mine: false, nodes: [{ t: "text", v: `text ${id}` }], truncated: false, attachments: [], ...over });
const person = (client: unknown = rpcClient([])) => ({ laneId: "PKG", userId: ME, connectionId: "00000000-0000-4000-8000-0000000000c1", client: client as never });
const rpcClient = (markers: { chat_id: string; read_through: string }[], error: unknown = null) => ({ schema: () => ({ rpc: async () => ({ data: markers, error }) }) });
const self = { tenantId: "t", entraObjectId: ME };

beforeEach(() => {
  reader.listChats.mockReset();
  reader.listMessages.mockReset();
  reader.openChat.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("titles and rows", () => {
  it("a topic, else the other people's names (three, then +n), else 'Chat'", () => {
    expect(chatTitle({ topic: "Budget", members: [member("A")] })).toBe("Budget");
    expect(chatTitle({ topic: null, members: [member("Me", { self: true }), member("Pat")] })).toBe("Pat");
    expect(chatTitle({ topic: null, members: [member("Me", { self: true }), member("A"), member("B"), member("C"), member("D"), member("E")] })).toBe("A, B, C +2");
    expect(chatTitle({ topic: null, members: [member("Me", { self: true })] })).toBe("Chat");
    expect(chatTitle({ topic: null, members: [] })).toBe("Chat");
  });

  it("unread combines Teams' read time with the portal's marker; the selected chat is not unread; senders and 'You:' are in the preview; External is labelled", () => {
    const base = chat();
    expect(chatRow(base as never, null, false, NOW)).toMatchObject({ unread: true, preview: "Pat Example: hello there", time: "9:05 AM", external: false, title: "Pat Example", key: encodeChatKey(CHAT) });
    expect(chatRow(base as never, "2026-11-23T14:05:00.000Z", false, NOW).unread).toBe(false); // the portal's marker is at the newest message
    expect(chatRow(base as never, "2026-11-22T00:00:00.000Z", false, NOW).unread).toBe(true); // an older marker does not clear it
    expect(chatRow(base as never, null, true, NOW).unread).toBe(false); // open right now
    const mine = chat({ preview: { ...base.preview, mine: true } });
    expect(chatRow(mine as never, null, false, NOW)).toMatchObject({ unread: false, preview: "You: hello there" });
    expect(chatRow(chat({ members: [member("Me", { self: true }), member("Ext", { external: true })] }) as never, null, false, NOW).external).toBe(true);
    expect(chatRow(chat({ preview: { ...base.preview, deleted: true } }) as never, null, false, NOW).preview).toBe("This message was deleted");
    expect(chatRow(chat({ preview: { ...base.preview, system: true } }) as never, null, false, NOW).preview).toBe("Teams event");
    expect(chatRow(chat({ preview: { ...base.preview, text: "" } }) as never, null, false, NOW).preview).toBe("Pat Example: Message");
    expect(chatRow(chat({ chatType: "oneOnOne" }) as never, null, false, NOW).preview).toBe("hello there");
    expect(chatRow(chat({ preview: null, lastReadAt: null }) as never, null, false, NOW)).toMatchObject({ unread: false, preview: "", time: "" });
  });
});

describe("loadChatList", () => {
  it("reads Graph and the markers together; marks unread from both; a hidden chat never arrives (the reader drops it)", async () => {
    reader.listChats.mockResolvedValue({ chats: [chat(), chat({ chatId: CHAT2, topic: "Second" })], nextCursor: "next-cursor", self });
    const v = await loadChatList(person(rpcClient([{ chat_id: CHAT2, read_through: "2026-11-23T14:05:00.000Z" }])), { selectedKey: null });
    expect(v.kind).toBe("ok");
    if (v.kind !== "ok") return;
    expect(v.rows.map((r) => [r.title, r.unread])).toEqual([["Pat Example", true], ["Second", false]]);
    expect(v.moreCursor).toBe("next-cursor");
    expect(reader.listChats).toHaveBeenCalledWith("PKG", "00000000-0000-4000-8000-0000000000c1", ME, {});
  });

  it("an explicit cursor goes to the reader; the selected chat is not unread", async () => {
    reader.listChats.mockResolvedValue({ chats: [chat()], nextCursor: null, self });
    const v = await loadChatList(person(), { cursor: "abc", selectedKey: encodeChatKey(CHAT) });
    expect(reader.listChats).toHaveBeenCalledWith("PKG", expect.any(String), ME, { cursor: "abc" });
    expect(v.kind === "ok" && v.rows[0]?.unread).toBe(false);
  });

  it("a Graph failure is a fixed state, never an empty list: busy (with seconds), reconnect, forbidden, unavailable", async () => {
    for (const [info, want] of [
      [{ kind: "rate_limited", retry_after_seconds: 9 }, { kind: "busy", seconds: 9 }],
      [{ kind: "reconnect_required" }, { kind: "reconnect" }],
      [{ kind: "forbidden" }, { kind: "forbidden" }],
      [{ kind: "timeout" }, { kind: "unavailable" }],
    ] as const) {
      reader.listChats.mockRejectedValue({ info: { ...info, message: `secret ${CANARY}` } });
      const v = await loadChatList(person(), { selectedKey: null });
      expect(v).toEqual(want);
      expect(JSON.stringify(v)).not.toContain(CANARY);
    }
  });

  it("an unreadable marker table is 'could not load', not 'everything is read'", async () => {
    reader.listChats.mockResolvedValue({ chats: [chat()], nextCursor: null, self });
    expect(await loadChatList(person(rpcClient([], { code: "XX000" })), { selectedKey: null })).toEqual({ kind: "unavailable" });
  });

  it("the Graph read and the marker read start in the same turn (neither waits for the other)", async () => {
    const order: string[] = [];
    reader.listChats.mockImplementation(async () => (order.push("graph"), { chats: [], nextCursor: null, self }));
    const client = { schema: () => ({ rpc: async () => (order.push("markers"), { data: [], error: null }) }) };
    await loadChatList(person(client), { selectedKey: null });
    expect(order.sort()).toEqual(["graph", "markers"]);
  });
});

describe("loadConversation", () => {
  const policy = { laneListsCalls: true, connectionHasCalls: true };
  const open = (members: ReturnType<typeof member>[], more = false, webUrl: string | null = null) => ({ chat: chat({ topic: "Team chat", webUrl, members: [] }), members, membersMore: more });

  it("starts the chat and the messages together; shows messages oldest first with the newest as the read-through; the Open in Teams link is built from the chat", async () => {
    reader.openChat.mockResolvedValue(open([member("Me", { self: true }), member("Pat", { userId: U1 })]));
    reader.listMessages.mockResolvedValue({ messages: [msg("m2", "2026-11-23T14:05:00.000Z"), msg("m1", "2026-11-23T14:00:00.000Z", { edited: true })], nextBefore: "2026-11-23T14:00:00.000Z", self });
    const v = await loadConversation(person(), CHAT, encodeChatKey(CHAT), policy);
    expect(v.kind).toBe("ok");
    if (v.kind !== "ok") return;
    expect(v.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(v.readThrough).toBe("2026-11-23T14:05:00.000Z");
    expect(v.nextBefore).toBe("2026-11-23T14:00:00.000Z");
    expect(v.title).toBe("Team chat");
    expect(v.subtitle).toBe("2 people");
    expect(v.group).toBe(false);
    expect(v.call).toBe("available");
    expect(v.openUrl).toBe(`https://teams.microsoft.com/l/chat/${CHAT}/conversations`);
    expect(v.messages[0]).toMatchObject({ time: "9:00 AM", day: "2026-11-23", edited: true, fullTime: "Nov 23, 2026, 9:00 AM ET" });
  });

  it("the chat's own teams.microsoft.com link is used; another host is ignored", async () => {
    reader.listMessages.mockResolvedValue({ messages: [], nextBefore: null, self });
    reader.openChat.mockResolvedValue(open([member("Me", { self: true }), member("Pat")], false, `https://teams.microsoft.com/l/chat/${CHAT}/0`));
    const a = await loadConversation(person(), CHAT, encodeChatKey(CHAT), policy);
    expect(a.kind === "ok" && a.openUrl).toBe(`https://teams.microsoft.com/l/chat/${CHAT}/0`);
    reader.openChat.mockResolvedValue(open([member("Me", { self: true }), member("Pat")], false, "https://evil.example.test/l/chat/x"));
    const b = await loadConversation(person(), CHAT, encodeChatKey(CHAT), policy);
    expect(b.kind === "ok" && b.openUrl).toBe(`https://teams.microsoft.com/l/chat/${CHAT}/conversations`);
  });

  it.each([
    ["1:1", [member("Me", { self: true }), member("Pat")], false, policy, "available"],
    ["group of 3", [member("Me", { self: true }), member("A"), member("B")], false, policy, "available"],
    ["an external member", [member("Me", { self: true }), member("A"), member("Ext", { external: true })], false, policy, "external"],
    ["11 others", [member("Me", { self: true }), ...Array.from({ length: 11 }, (_, i) => member(`P${String(i)}`))], false, policy, "too_many"],
    ["only me", [member("Me", { self: true })], false, policy, "no_one"],
    ["the company does not list call buttons", [member("Me", { self: true }), member("A")], false, { laneListsCalls: false, connectionHasCalls: false }, "off_lane"],
    ["the connection lacks call buttons", [member("Me", { self: true }), member("A")], false, { laneListsCalls: true, connectionHasCalls: false }, "needs_reconnect"],
    ["more members than Graph returned", [member("Me", { self: true }), member("A")], true, policy, "too_many"],
  ] as const)("call state, %s", async (_name, members, more, pol, want) => {
    reader.openChat.mockResolvedValue(open([...members], more));
    reader.listMessages.mockResolvedValue({ messages: [], nextBefore: null, self });
    const v = await loadConversation(person(), CHAT, encodeChatKey(CHAT), pol);
    expect(v.kind === "ok" && v.call).toBe(want);
  });

  it("group chats draw sender names; the subtitle names external people", async () => {
    reader.openChat.mockResolvedValue(open([member("Me", { self: true }), member("A"), member("Ext", { external: true })]));
    reader.listMessages.mockResolvedValue({ messages: [], nextBefore: null, self });
    const v = await loadConversation(person(), CHAT, encodeChatKey(CHAT), policy);
    expect(v.kind === "ok" && [v.group, v.external, v.subtitle]).toEqual([true, true, "3 people, includes external people"]);
  });

  it("a chat that is not found, and every Graph failure, are fixed states", async () => {
    reader.listMessages.mockResolvedValue({ messages: [], nextBefore: null, self });
    reader.openChat.mockResolvedValue({ chat: null, members: [], membersMore: false });
    expect(await loadConversation(person(), CHAT, "k", policy)).toEqual({ kind: "not_found" });
    reader.openChat.mockRejectedValue({ info: { kind: "not_found", message: "x" } });
    expect(await loadConversation(person(), CHAT, "k", policy)).toEqual({ kind: "not_found" });
    reader.openChat.mockRejectedValue({ info: { kind: "rate_limited", retry_after_seconds: 3 } });
    expect(await loadConversation(person(), CHAT, "k", policy)).toEqual({ kind: "busy", seconds: 3 });
    reader.openChat.mockRejectedValue(new Error(`boom ${CANARY}`));
    expect(JSON.stringify(await loadConversation(person(), CHAT, "k", policy))).not.toContain(CANARY);
  });

  it("older messages: one page before a time, oldest first", async () => {
    reader.listMessages.mockResolvedValue({ messages: [msg("m2", "2026-11-23T13:05:00.000Z"), msg("m1", "2026-11-23T13:00:00.000Z")], nextBefore: null, self });
    const r = await loadOlder({ laneId: "PKG", userId: ME, connectionId: "c" }, CHAT, "2026-11-23T14:00:00.000Z");
    expect(reader.listMessages).toHaveBeenCalledWith("PKG", "c", ME, CHAT, { before: "2026-11-23T14:00:00.000Z" });
    expect(r.kind === "ok" && r.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    reader.listMessages.mockRejectedValue({ info: { kind: "rate_limited", retry_after_seconds: 2 } });
    expect(await loadOlder({ laneId: "PKG", userId: ME, connectionId: "c" }, CHAT, "2026-11-23T14:00:00.000Z")).toEqual({ kind: "busy", seconds: 2 });
  });
});

describe("privacy (rule 6)", () => {
  it("chat content reaches no console, no log: a canary in titles, previews, member names and message text is only in the returned views", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    reader.listChats.mockResolvedValue({ chats: [chat({ topic: CANARY, preview: { createdAt: "2026-11-23T14:05:00.000Z", senderId: U1, senderName: CANARY, mine: false, text: CANARY, deleted: false, system: false } })], nextCursor: null, self });
    reader.openChat.mockResolvedValue({ chat: chat({ topic: CANARY }), members: [member("Me", { self: true }), member(CANARY)], membersMore: false });
    reader.listMessages.mockResolvedValue({ messages: [msg("m1", "2026-11-23T14:05:00.000Z", { nodes: [{ t: "text", v: CANARY }] })], nextBefore: null, self });
    const list = await loadChatList(person(), { selectedKey: null });
    const conv = await loadConversation(person(), CHAT, "k", { laneListsCalls: true, connectionHasCalls: true });
    expect(JSON.stringify([list, conv])).toContain(CANARY);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(CANARY);
    reader.listChats.mockRejectedValue({ info: { kind: "provider_error", message: CANARY } });
    expect(JSON.stringify(await loadChatList(person(), { selectedKey: null }))).not.toContain(CANARY);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(CANARY);
    vi.restoreAllMocks();
  });

  it("T-285: a conversation's messages carry the same-site image address of THEIR OWN message (chat key and message id, validated), and none for an id that is not valid", async () => {
    reader.openChat.mockResolvedValue({ chat: chat({ topic: "Team chat", members: [] }), members: [member("Me", { self: true }), member("Pat")], membersMore: false });
    reader.listMessages.mockResolvedValue({ messages: [msg("1700000000001", "2026-11-23T14:05:00.000Z"), msg("bad id/with slash", "2026-11-23T14:06:00.000Z")], nextBefore: null, self });
    const v = await loadConversation(person(), CHAT, encodeChatKey(CHAT), { laneListsCalls: true, connectionHasCalls: true });
    expect(v.kind === "ok" && v.messages.map((m) => m.images)).toEqual([null, `/api/lanes/PKG/messages/image?chat=${encodeChatKey(CHAT)}&message=1700000000001`]); // oldest first: the second message has no valid id
    reader.listMessages.mockResolvedValue({ messages: [msg("1700000000002", "2026-11-23T13:00:00.000Z")], nextBefore: null, self });
    const older = await loadOlder(person(), CHAT, "2026-11-23T14:00:00.000Z");
    expect(older.kind === "ok" && older.messages[0]?.images).toBe(`/api/lanes/PKG/messages/image?chat=${encodeChatKey(CHAT)}&message=1700000000002`);
  });

  it("messageView carries only what the page draws (no raw body, no ids of members)", () => {
    const v = messageView(msg("m1", "2026-11-23T14:05:00.000Z") as never);
    expect(Object.keys(v).sort()).toEqual(["at", "attachments", "day", "deleted", "edited", "fullTime", "id", "images", "mine", "modifiedAt", "nodes", "sender", "system", "time", "truncated"]);
  });
});

describe("T-281 review follow-ups", () => {
  const policy = { laneListsCalls: true, connectionHasCalls: true };
  it("C4: events are not drawn (conversation and older pages), but the newest item of any kind is what opening the chat marks as read", async () => {
    reader.openChat.mockResolvedValue({ chat: chat({ topic: "T", members: [] }), members: [member("Me", { self: true }), member("Pat")], membersMore: false });
    reader.listMessages.mockResolvedValue({
      messages: [msg("e2", "2026-11-23T15:00:00.000Z", { system: true, nodes: [] }), msg("m2", "2026-11-23T14:05:00.000Z"), msg("e1", "2026-11-23T14:02:00.000Z", { system: true, nodes: [] }), msg("m1", "2026-11-23T14:00:00.000Z")],
      nextBefore: null,
      self,
    });
    const v = await loadConversation(person(), CHAT, encodeChatKey(CHAT), policy);
    expect(v.kind === "ok" && v.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(v.kind === "ok" && v.readThrough).toBe("2026-11-23T15:00:00.000Z");
    const o = await loadOlder({ laneId: "PKG", userId: ME, connectionId: "c" }, CHAT, "2026-11-23T14:00:00.000Z");
    expect(o.kind === "ok" && o.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("C6: a chat with more members than Graph returns says 'and others', not a wrong number", () => {
    const many = [member("Me", { self: true }), ...["A", "B", "C", "D", "E"].map((n) => member(n))];
    expect(chatTitle({ topic: null, members: many, membersCapped: true })).toBe("A, B, C and others");
    expect(chatTitle({ topic: null, members: many, membersCapped: false })).toBe("A, B, C +2");
    expect(chatRow(chat({ topic: null, members: many, membersCapped: true }) as never, null, false, NOW).title).toBe("A, B, C and others");
  });

  it("C6: a conversation with more members than the first page says so in the title", async () => {
    reader.openChat.mockResolvedValue({ chat: chat({ topic: null, members: [] }), members: [member("Me", { self: true }), ...["A", "B", "C", "D"].map((n) => member(n))], membersMore: true });
    reader.listMessages.mockResolvedValue({ messages: [], nextBefore: null, self });
    const v = await loadConversation(person(), CHAT, encodeChatKey(CHAT), policy);
    expect(v.kind === "ok" && [v.title, v.subtitle]).toEqual(["A, B, C and others", "5+ people"]);
  });

  it("C7k: a chat with no messages is an empty, valid conversation; a 400 on the messages read is a fixed state", async () => {
    reader.openChat.mockResolvedValue({ chat: chat({ topic: "T", members: [] }), members: [member("Me", { self: true }), member("Pat")], membersMore: false });
    reader.listMessages.mockResolvedValue({ messages: [], nextBefore: null, self });
    const v = await loadConversation(person(), CHAT, encodeChatKey(CHAT), policy);
    expect(v.kind === "ok" && [v.messages.length, v.readThrough, v.nextBefore]).toEqual([0, null, null]);
    reader.listMessages.mockRejectedValue({ info: { kind: "invalid_input", http_status: 400, message: CANARY } });
    expect(await loadConversation(person(), CHAT, encodeChatKey(CHAT), policy)).toEqual({ kind: "unavailable" });
  });
});
