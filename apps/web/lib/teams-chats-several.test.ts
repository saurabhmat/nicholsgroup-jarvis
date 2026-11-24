// T-295 (docs/specs/messages.md 22.5, 22.6, 22.12 tests 30 and 31): the combined chat list of two accounts of ONE person. The Teams reader is faked (its rules are tested in packages/connectors);
// the markers come from ONE database call. Synthetic data only.
import { beforeEach, describe, expect, it, vi } from "vitest";

const reader = vi.hoisted(() => ({ listChats: vi.fn(), listMessages: vi.fn(), openChat: vi.fn() }));
vi.mock("@nichols/connectors/teams-reader", () => ({ ...reader }));

import { loadChatLists, splitMemberBudget, type ChatSource } from "./teams-chats";
import { accountLabels } from "./teams-accounts";
import { decodeCursor, encodeCursor, CURSOR_MAX_CHARS } from "./teams-cursor";
import { compareRows, dedupeRows, replaceAccountRows } from "./teams-row-order";
import { encodeChatKey } from "./teams-chat-key";

const ME = "00000000-0000-4000-8000-0000000000a1";
const A = "00000000-0000-4000-8000-0000000000c1";
const B = "00000000-0000-4000-8000-0000000000c2";
const FOREIGN = "00000000-0000-4000-8000-0000000000f9";
const SRC_A: ChatSource = { connectionId: A, label: "pubkgroup.com", account: "robert@pubkgroup.com", ord: 0 };
const SRC_B: ChatSource = { connectionId: B, label: "pub-k.org", account: "robert@pub-k.org", ord: 1 };
const SHARED = "19:shared111@thread.v2";
const member = (name: string, self = false) => ({ userId: null, displayName: name, tenantId: "t", external: false, self });
const chat = (id: string, at: string | null, over: Record<string, unknown> = {}) => ({
  chatId: id, chatType: "group", topic: `topic ${id.slice(3, 9)}`, webUrl: null, members: [member("Me", true), member("Pat")], membersCapped: false, lastReadAt: null, hidden: false,
  preview: at === null ? null : { createdAt: at, senderId: "u", senderName: "Pat", mine: false, text: "hi", deleted: false, system: false }, ...over,
});
const self = { tenantId: "t", entraObjectId: ME };
const markersCalls: { fn: string; args: Record<string, unknown> }[] = [];
const client = (markers: Record<string, { chat_id: string; read_through: string }[]> = {}, error: unknown = null) => ({
  schema: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      markersCalls.push({ fn, args });
      return { data: Object.entries(markers).flatMap(([connection_id, rows]) => rows.map((r) => ({ connection_id, ...r }))), error };
    },
  }),
});
const person = (c: unknown = client()) => ({ laneId: "PKG", userId: ME, client: c as never });

beforeEach(() => {
  reader.listChats.mockReset();
  markersCalls.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-23T17:00:00Z"));
});
const answer = (m: Record<string, unknown>) => reader.listChats.mockImplementation(async (_l: string, conn: string) => {
  const v = m[conn];
  if (v instanceof Error || (typeof v === "object" && v !== null && "info" in v)) throw v;
  return v;
});

describe("labels (spec 22.5)", () => {
  it("the domain when the domains differ, else the part before the @, else the whole name; never from chat content", () => {
    expect(accountLabels(["robert@pubkgroup.com", "robert@pub-k.org"])).toEqual(["pubkgroup.com", "pub-k.org"]);
    expect(accountLabels(["robert@example.test", "assistant@example.test"])).toEqual(["robert", "assistant"]);
    expect(accountLabels(["a@one.test", "a@one.test"])).toEqual(["a@one.test", "a@one.test"]);
    expect(accountLabels(["Robert@PubKGroup.com", "robert@pub-k.org"])).toEqual(["pubkgroup.com", "pub-k.org"]);
  });
});

describe("the combined list of two accounts", () => {
  it("interleaved preview times come out in time order, each row with its own account label and connection; ONE markers query; one list read per account", async () => {
    answer({
      [A]: { chats: [chat("19:a1@thread.v2", "2026-11-23T16:00:00Z"), chat("19:a2@thread.v2", "2026-11-23T10:00:00Z")], nextCursor: null, self },
      [B]: { chats: [chat("19:b1@thread.v2", "2026-11-23T15:00:00Z"), chat("19:b2@thread.v2", "2026-11-23T11:00:00Z"), chat("19:b3@thread.v2", null)], nextCursor: null, self },
    });
    const v = await loadChatLists(person(), [SRC_A, SRC_B], { selectedKey: null });
    expect(v.kind).toBe("ok");
    if (v.kind !== "ok") return;
    expect(v.rows.map((r) => [r.key, r.conn, r.account])).toEqual([
      [encodeChatKey("19:a1@thread.v2"), A, "pubkgroup.com"],
      [encodeChatKey("19:b1@thread.v2"), B, "pub-k.org"],
      [encodeChatKey("19:b2@thread.v2"), B, "pub-k.org"],
      [encodeChatKey("19:a2@thread.v2"), A, "pubkgroup.com"],
      [encodeChatKey("19:b3@thread.v2"), B, "pub-k.org"], // no preview: last
    ]);
    expect(v.rows.find((r) => r.conn === A)?.accountName).toBe("robert@pubkgroup.com");
    expect(reader.listChats).toHaveBeenCalledTimes(2); // one list read per account and nothing else
    expect(markersCalls).toHaveLength(1);
    expect(markersCalls[0]).toEqual({ fn: "teams_chat_reads_list_many", args: { p_lane: "PKG", p_connections: [A, B] } });
    expect(v.listed).toEqual([A, B]);
    expect(v.notes).toBeUndefined();
  });

  it("a chat both accounts are in is TWO rows, one per account, each with its own unread state; a 1:1 chat between the person's own accounts is two rows too (D-70)", async () => {
    answer({
      [A]: { chats: [chat(SHARED, "2026-11-23T14:00:00Z")], nextCursor: null, self },
      [B]: { chats: [chat(SHARED, "2026-11-23T14:00:00Z")], nextCursor: null, self },
    });
    // account A has read it, account B has not
    const v = await loadChatLists(person(client({ [A]: [{ chat_id: SHARED, read_through: "2026-11-23T14:00:00Z" }] })), [SRC_A, SRC_B], { selectedKey: null });
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows).toHaveLength(2);
    expect(v.rows.map((r) => [r.conn, r.key, r.unread])).toEqual([[A, encodeChatKey(SHARED), false], [B, encodeChatKey(SHARED), true]]); // tie: same time and key, ordered by connection order
    expect(v.rows.map((r) => r.account)).toEqual(["pubkgroup.com", "pub-k.org"]);
    // the open chat is the (account, chat) PAIR: opening B's row does not clear A's, and vice versa
    const open = await loadChatLists(person(), [SRC_A, SRC_B], { selectedKey: encodeChatKey(SHARED), selectedConn: B });
    if (open.kind !== "ok") throw new Error("expected ok");
    expect(open.rows.map((r) => [r.conn, r.unread])).toEqual([[A, true], [B, false]]);
  });

  it("the tie rule is deterministic: same time, then chat key, then the order the accounts were connected in", () => {
    const rows = [
      { at: "2026-11-23T10:00:00Z", key: "b", ord: 1 },
      { at: "2026-11-23T10:00:00Z", key: "a", ord: 1 },
      { at: "2026-11-23T10:00:00Z", key: "a", ord: 0 },
      { at: null, key: "0", ord: 0 },
    ];
    expect([...rows].reverse().sort(compareRows)).toEqual([rows[2], rows[1], rows[0], rows[3]]);
  });

  it("one account only: Graph's own order is kept exactly (no re-sort, no label) and the cursor is the combined form with one entry", async () => {
    answer({ [A]: { chats: [chat("19:z@thread.v2", "2026-11-23T10:00:00Z"), chat("19:a@thread.v2", "2026-11-23T10:00:00Z")], nextCursor: "tok1", self } });
    const v = await loadChatLists(person(), [{ ...SRC_A, label: null }], { selectedKey: null });
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows.map((r) => r.key)).toEqual([encodeChatKey("19:z@thread.v2"), encodeChatKey("19:a@thread.v2")]); // Graph's order, not the key order
    expect(v.rows.every((r) => r.account === null && r.accountName === null)).toBe(true);
    expect(decodeCursor(v.moreCursor)).toEqual([{ conn: A, token: "tok1" }]);
  });
});

describe("paging across sources (the combined cursor)", () => {
  it("both sources have more: the cursor holds both; 'More chats' reads the next page of each with its own token and merges that page among itself", async () => {
    answer({
      [A]: { chats: [chat("19:a1@thread.v2", "2026-11-23T16:00:00Z")], nextCursor: "tokA", self },
      [B]: { chats: [chat("19:b1@thread.v2", "2026-11-23T15:00:00Z")], nextCursor: "tokB", self },
    });
    const first = await loadChatLists(person(), [SRC_A, SRC_B], { selectedKey: null });
    if (first.kind !== "ok") throw new Error("expected ok");
    expect(decodeCursor(first.moreCursor)).toEqual([{ conn: A, token: "tokA" }, { conn: B, token: "tokB" }]);
    reader.listChats.mockClear();
    answer({
      [A]: { chats: [chat("19:a0@thread.v2", "2026-11-22T09:00:00Z")], nextCursor: null, self },
      [B]: { chats: [chat("19:b0@thread.v2", "2026-11-22T10:00:00Z")], nextCursor: "tokB2", self },
    });
    const second = await loadChatLists(person(), [SRC_A, SRC_B], { cursor: first.moreCursor, selectedKey: null });
    if (second.kind !== "ok") throw new Error("expected ok");
    expect(reader.listChats).toHaveBeenCalledWith("PKG", A, ME, { cursor: "tokA", memberReads: 10 });
    expect(reader.listChats).toHaveBeenCalledWith("PKG", B, ME, { cursor: "tokB", memberReads: 10 });
    expect(second.rows.map((r) => r.conn)).toEqual([B, A]); // ordered within the page
    expect(decodeCursor(second.moreCursor)).toEqual([{ conn: A, token: "" }, { conn: B, token: "tokB2" }]); // A has no more
    // the third page reads only B
    reader.listChats.mockClear();
    answer({ [B]: { chats: [], nextCursor: null, self } });
    await loadChatLists(person(), [SRC_A, SRC_B], { cursor: second.moreCursor, selectedKey: null });
    expect(reader.listChats).toHaveBeenCalledTimes(1);
    expect(reader.listChats.mock.calls[0]?.[1]).toBe(B);
  });

  it("a cursor that names a connection that is not one of the person's usable accounts: that entry is dropped (fixed line), the others are read, the foreign token reaches nobody", async () => {
    const cursor = encodeCursor([{ conn: A, token: "tokA" }, { conn: FOREIGN, token: "evilTok" }]);
    answer({ [A]: { chats: [chat("19:a0@thread.v2", "2026-11-22T09:00:00Z")], nextCursor: null, self } });
    const v = await loadChatLists(person(), [SRC_A, SRC_B], { cursor, selectedKey: null });
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.dropped).toBe(true);
    expect(reader.listChats).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(reader.listChats.mock.calls)).not.toContain("evilTok");
    expect(JSON.stringify(reader.listChats.mock.calls)).not.toContain(FOREIGN);
    expect(v.rows).toHaveLength(1);
  });

  it("hostile cursors are 'not a cursor' (the newest chats are shown, nothing hostile is passed on): bad base64, not JSON, another version, too many entries, a duplicate, a bad id, a bad token, an extra key, too long, the wrong type", async () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    const e = (c: string, k: string) => ({ c, k });
    const hostile: unknown[] = [
      "!!!", "not-json".padEnd(12, "x"), enc("a string"), enc([1, 2]), enc({ v: 2, s: [e(A, "t")] }), enc({ v: 1, s: [] }), enc({ v: 1 }), enc({ v: 1, s: [e(A, "t")], x: 1 }),
      enc({ v: 1, s: [e(A, "t"), e(A, "u")] }), enc({ v: 1, s: [e("nope", "t")] }), enc({ v: 1, s: [e(A.toUpperCase(), "t")] }), enc({ v: 1, s: [e(A, "a b")] }), enc({ v: 1, s: [e(A, "x".repeat(3201))] }),
      enc({ v: 1, s: [e(A, "../../etc")] }), enc({ v: 1, s: [{ c: A }] }), enc({ v: 1, s: [{ c: A, k: 5 }] }),
      enc({ v: 1, s: Array.from({ length: 6 }, (_, i) => e(`00000000-0000-4000-8000-00000000000${String(i)}`, "t")) }),
      "A".repeat(CURSOR_MAX_CHARS + 1), 42, null, undefined, {},
      `${enc({ v: 1, s: [e(A, "t")] })}=`, // a padded value is not the canonical form
    ];
    for (const h of hostile) expect(decodeCursor(h), String(h).slice(0, 40)).toBeNull();
    // through the loader: with two sources a hostile value is just the first page again
    answer({ [A]: { chats: [], nextCursor: null, self }, [B]: { chats: [], nextCursor: null, self } });
    for (const h of ["!!!", enc({ v: 2, s: [] })]) {
      reader.listChats.mockClear();
      await loadChatLists(person(), [SRC_A, SRC_B], { cursor: h, selectedKey: null });
      expect(reader.listChats.mock.calls.map((c) => c[3])).toEqual([{ memberReads: 10 }, { memberReads: 10 }]); // first pages, no token
    }
  });

  it("the cursor builder fails closed: nothing more is no cursor; more than 5 entries, a bad id or token, a duplicate, or a value past 6,400 characters is no cursor", () => {
    expect(encodeCursor([{ conn: A, token: null }, { conn: B, token: null }])).toBeNull();
    expect(encodeCursor([])).toBeNull();
    expect(encodeCursor([{ conn: "x", token: "t" }])).toBeNull();
    expect(encodeCursor([{ conn: A, token: "a b" }])).toBeNull();
    expect(encodeCursor([{ conn: A, token: "t" }, { conn: A, token: "u" }])).toBeNull();
    expect(encodeCursor(Array.from({ length: 6 }, (_, i) => ({ conn: `00000000-0000-4000-8000-00000000000${String(i)}`, token: "t" })))).toBeNull();
    expect(encodeCursor([{ conn: A, token: "x".repeat(3200) }, { conn: B, token: "y".repeat(3200) }])).toBeNull(); // 6,400 characters of tokens do not fit in 6,400 characters of cursor
    expect(encodeCursor([{ conn: A, token: "t" }, { conn: B, token: null }])).not.toBeNull();
  });

  it("the member-read budget of 20 is split across the sources in list order (the first ones get the remainder)", () => {
    expect(splitMemberBudget(20, 1)).toEqual([20]);
    expect(splitMemberBudget(20, 2)).toEqual([10, 10]);
    expect(splitMemberBudget(20, 3)).toEqual([7, 7, 6]);
    expect(splitMemberBudget(20, 0)).toEqual([]);
  });

  it("a row already shown is not drawn twice; one account's rows are replaced without touching the other's", () => {
    const r = (conn: string, key: string, at: string, ord = 0) => ({ conn, key, at, ord });
    expect(dedupeRows([r(A, "k1", "2026-01-01T00:00:00Z"), r(A, "k1", "2026-01-02T00:00:00Z"), r(B, "k1", "2026-01-01T00:00:00Z")])).toHaveLength(2);
    const now = [r(A, "k1", "2026-11-23T10:00:00Z"), r(B, "k2", "2026-11-23T09:00:00Z", 1)];
    const next = replaceAccountRows(now, A, [r(A, "k3", "2026-11-23T11:00:00Z"), r(A, "k1", "2026-11-23T10:00:00Z")]);
    expect(next.map((x) => [x.conn, x.key])).toEqual([[A, "k3"], [A, "k1"], [B, "k2"]]);
  });
});

describe("partial failure (spec 22.5)", () => {
  const reconnect = { info: { kind: "reconnect_required", message: "secret text" } };
  const busy = { info: { kind: "rate_limited", retry_after_seconds: 7, message: "secret text" } };

  it("one account needs a reconnect and the other works: the other's rows and one line for the broken one (with its connection, for its own Reconnect); the failed account is not 'listed'", async () => {
    answer({ [A]: reconnect, [B]: { chats: [chat("19:b1@thread.v2", "2026-11-23T15:00:00Z")], nextCursor: null, self } });
    const v = await loadChatLists(person(), [SRC_A, SRC_B], { selectedKey: null });
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows.map((r) => r.conn)).toEqual([B]);
    expect(v.notes).toEqual([{ conn: A, label: "pubkgroup.com", kind: "reconnect", seconds: null }]);
    expect(v.listed).toEqual([B]);
    expect(JSON.stringify(v)).not.toContain("secret text");
  });

  it("one account is throttled: its line says busy with the seconds; the other's chats are shown", async () => {
    answer({ [A]: { chats: [chat("19:a1@thread.v2", "2026-11-23T15:00:00Z")], nextCursor: null, self }, [B]: busy });
    const v = await loadChatLists(person(), [SRC_A, SRC_B], { selectedKey: null });
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows.map((r) => r.conn)).toEqual([A]);
    expect(v.notes).toEqual([{ conn: B, label: "pub-k.org", kind: "busy", seconds: 7 }]);
  });

  it("an unreachable account is a 'could not be reached' line; every source failing is the existing failure (the card), with a line each", async () => {
    answer({ [A]: { info: { kind: "timeout" } }, [B]: { chats: [], nextCursor: null, self } });
    const some = await loadChatLists(person(), [SRC_A, SRC_B], { selectedKey: null });
    expect(some).toMatchObject({ kind: "ok", notes: [{ conn: A, kind: "unreachable" }] });
    answer({ [A]: reconnect, [B]: busy });
    const all = await loadChatLists(person(), [SRC_A, SRC_B], { selectedKey: null });
    expect(all).toMatchObject({ kind: "reconnect", notes: [{ conn: A, kind: "reconnect" }, { conn: B, kind: "busy", seconds: 7 }] });
    // one account failing alone is exactly the old failure with no extra lines
    answer({ [A]: busy });
    expect(await loadChatLists(person(), [{ ...SRC_A, label: null }], { selectedKey: null })).toEqual({ kind: "busy", seconds: 7 });
  });

  it("an unreadable markers query is 'could not load', never 'everything is read'", async () => {
    answer({ [A]: { chats: [chat("19:a1@thread.v2", "2026-11-23T15:00:00Z")], nextCursor: null, self }, [B]: { chats: [], nextCursor: null, self } });
    expect(await loadChatLists(person(client({}, { code: "XX000" })), [SRC_A, SRC_B], { selectedKey: null })).toEqual({ kind: "unavailable" });
  });
});
