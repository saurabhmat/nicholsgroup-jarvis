// T-295 (docs/specs/messages.md 22.4, 22.6, 22.7, 22.12 tests 29, 31, 32): the Messages routes name a connection by `conn`, the person's OWN connection id. Every route re-checks it before any Graph
// call or token read: another person's id, another lane's id, a disconnected one, a pending one and an unknown uuid all give the SAME 404 with ZERO reader calls (the reader is where a token is
// read and Graph is called); a non-uuid or a missing `conn` is 400; the person's own expired account is 409. Two accounts of one person; synthetic data only.
import { beforeEach, describe, expect, it, vi } from "vitest";

const reader = vi.hoisted(() => ({ resolveCallTargets: vi.fn(), listMessages: vi.fn(), listChats: vi.fn(), openChat: vi.fn(), fetchHostedImage: vi.fn() }));
vi.mock("@nichols/connectors/teams-reader", () => ({ ...reader }));

import { createTeamsRoutes, type TeamsRouteDeps } from "@/lib/teams-api";
import { encodeChatKey } from "@/lib/teams-chat-key";
import { decodeCursor, encodeCursor } from "@/lib/teams-cursor";
import { createWindowLimiter } from "@/lib/teams-activity";

const ME = "00000000-0000-4000-8000-0000000000aa";
const A = "00000000-0000-4000-8000-0000000000c1";
const B = "00000000-0000-4000-8000-0000000000c2";
const OTHER_PERSON = "00000000-0000-4000-8000-0000000000d1";
const OTHER_LANE = "00000000-0000-4000-8000-0000000000e1";
const DISCONNECTED = "00000000-0000-4000-8000-0000000000d2";
const PENDING = "00000000-0000-4000-8000-0000000000d3";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";
const CHAT = "19:abc123def456@thread.v2";
const KEY = encodeChatKey(CHAT);
const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1";
const row = (id: string, account: string, over: Record<string, unknown> = {}) => ({ id, account, state: "connected", mine: true, has: ["chat_read", "call_links", "channels_read"], ...over });
// the rows the person's own client can see under RLS in THIS lane: their two accounts, another person's (an admin sees its health), and a disconnected one; a pending one is never listed; another lane's is not here
const ROWS = [row(A, "robert@pubkgroup.com"), row(B, "robert@pub-k.org"), row(OTHER_PERSON, "x@pubkgroup.com", { mine: false }), row(DISCONNECTED, "old@pubkgroup.com", { state: "disconnected" })];

// L7: a token is read ONLY inside the Teams reader (`@nichols/connectors/teams-reader`, which loads the connection and calls the guard); the routes never touch the Vault. So "zero reader calls" is also "zero token reads"
// and "zero Graph requests": there is no other path to either.
const everyReaderCall = () => Object.values(reader).flatMap((f) => f.mock.calls);
type Rec = { fn: string; args: Record<string, unknown> };
function setup(opts: { rows?: unknown[]; activity?: Record<string, unknown>; seenFail?: string[] } = {}) {
  const rpc: Rec[] = [];
  const client = {
    schema: () => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpc.push({ fn, args });
        if (fn === "teams_activity_get") return { data: [opts.activity?.[String(args.p_connection)] ?? { live: false, live_until: null, last_notice_at: null, last_seen_at: null }], error: null };
        if (fn === "teams_activity_seen") return { data: null, error: opts.seenFail?.includes(String(args.p_connection)) ? { code: "P0002" } : null };
        if (fn === "teams_chat_reads_list_many") return { data: [], error: null };
        return { data: null, error: null };
      },
    }),
  };
  const deps: TeamsRouteDeps = {
    guards: async () => ({ requireLane: async () => ({ client, session: { userId: ME } }) as never, requireRole: async () => ({ client, session: { userId: ME } }) as never }),
    gate: async () => ({ limited: false, newsShown: true, visible: () => true }),
    rows: async () => (opts.rows ?? ROWS) as never,
    limiters: { activity: createWindowLimiter(100, 60_000), reads: createWindowLimiter(100, 60_000) },
  };
  return { routes: createTeamsRoutes(deps), rpc };
}
const SAME = { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" };
const url = (path: string, qs = "") => `http://localhost:3000/api/lanes/PKG/messages/${path}${qs ? `?${qs}` : ""}`;
const getReq = (path: string, qs: string) => new Request(url(path, qs), { headers: { "sec-fetch-site": "same-origin" } });
const postReq = (path: string, body: unknown) => new Request(url(path), { method: "POST", headers: { "content-type": "application/json", ...SAME }, body: typeof body === "string" ? body : JSON.stringify(body) });
const T = (m: number) => new Date(Date.UTC(2026, 10, 23, 15, m)).toISOString();

beforeEach(() => {
  for (const f of Object.values(reader)) f.mockReset();
  reader.listChats.mockResolvedValue({ chats: [], nextCursor: null, self: { tenantId: "t", entraObjectId: ME } });
  reader.listMessages.mockResolvedValue({ messages: [], nextBefore: null });
  reader.resolveCallTargets.mockResolvedValue({ ok: true, upns: ["pat@teams.example.test"] });
  reader.fetchHostedImage.mockResolvedValue({ ok: true, bytes: new Uint8Array([1]), contentType: "image/png" });
});

/** Every route that names a connection, as a function of the `conn` it is given. */
const ROUTES: [string, (s: ReturnType<typeof setup>, conn: string | undefined) => Promise<Response>][] = [
  ["older", (s, c) => s.routes.older(getReq("older", `${c ? `conn=${c}&` : ""}chat=${KEY}&before=${T(1)}`), "PKG")],
  ["newer", (s, c) => s.routes.newer(getReq("newer", `${c ? `conn=${c}&` : ""}chat=${KEY}&since=${T(1)}`), "PKG")],
  ["read", (s, c) => s.routes.read(postReq("read", { ...(c ? { conn: c } : {}), chat: KEY, readThrough: T(1) }), "PKG")],
  ["call-link", (s, c) => s.routes.callLink(postReq("call-link", { ...(c ? { conn: c } : {}), chat: KEY, video: false }), "PKG")],
  ["image (chat)", (s, c) => s.routes.image(getReq("image", `${c ? `conn=${c}&` : ""}chat=${KEY}&message=1700000000001&hosted=h1`), "PKG")],
  ["image (channel)", (s, c) => s.routes.image(getReq("image", `${c ? `conn=${c}&` : ""}team=${TEAM}&channel=${KEY}&message=1700000000001&hosted=h1`), "PKG")],
  ["chats?conn", (s, c) => s.routes.chats(getReq("chats", c ? `conn=${c}` : "conn="), "PKG")],
];

describe("conn addressing: the checks come before any Graph call or token read (test 29)", () => {
  it.each(ROUTES)("%s: the person's own accounts work", async (name, call) => {
    const s = setup();
    for (const conn of [A, B]) expect((await call(s, conn)).status, `${name} ${conn}`).toBeLessThan(300);
    // each call reached the reader with ITS connection and the signed-in person (the read marker is the portal's own database, not the reader)
    if (name === "read") return expect(s.rpc.filter((r) => r.fn === "teams_chat_read_mark").map((r) => r.args.p_connection)).toEqual([A, B]);
    const named = everyReaderCall().map((c) => c[1]);
    expect(named).toContain(A);
    expect(named).toContain(B);
    expect(everyReaderCall().every((c) => c[2] === ME)).toBe(true);
  });

  it.each(ROUTES)("%s: another person's id, another lane's id, a disconnected one, a pending one and an unknown uuid are the SAME 404 with zero reader calls", async (name, call) => {
    const s = setup();
    const bodies = new Set<string>();
    for (const conn of [OTHER_PERSON, OTHER_LANE, DISCONNECTED, PENDING, UNKNOWN]) {
      const res = await call(s, conn);
      expect(res.status, `${name} ${conn}`).toBe(404);
      expect(res.headers.get("cache-control")).toContain("no-store");
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1); // one and the same answer: nothing says which kind of id it was
    expect([...bodies][0]).toBe(JSON.stringify({ error: "not_found" }));
    expect(everyReaderCall()).toEqual([]); // no Graph request, no token read
    expect(s.rpc.filter((r) => r.fn.includes("chat_read_mark"))).toEqual([]);
  });

  it.each(ROUTES.filter(([n]) => n !== "chats?conn"))("%s: a `conn` that is not a lower-case uuid, or is missing, is 400 with zero reader calls", async (name, call) => {
    const s = setup();
    for (const bad of ["../x", "not-a-uuid", A.toUpperCase(), `${A}x`, A.slice(0, 35), "robert@pubkgroup.com", "%00", "1; drop"]) expect((await call(s, bad)).status, `${name} ${bad}`).toBe(400);
    expect((await call(s, undefined)).status, `${name} missing`).toBe(400);
    expect(everyReaderCall()).toEqual([]);
  });

  it("an expired sign-in of the person's own account is 409 `reconnect` (the person may be told), another person's expired one is still 404; no reader call", async () => {
    const rows = [row(A, "robert@pubkgroup.com", { state: "reconnect_required" }), row(B, "robert@pub-k.org"), row(OTHER_PERSON, "x@y.test", { mine: false, state: "reconnect_required" })];
    const s = setup({ rows });
    for (const [name, call] of ROUTES.filter(([n]) => n !== "chats?conn")) {
      expect((await call(s, A)).status, name).toBe(409);
      expect((await call(s, OTHER_PERSON)).status, name).toBe(404);
    }
    expect(everyReaderCall()).toEqual([]);
    // the other account of the same person still works
    expect((await ROUTES[0]?.[1](s, B))?.status).toBe(200);
  });

  it("a feature missing on the NAMED account is 409 for that account only; the other account's feature does not count", async () => {
    const rows = [row(A, "robert@pubkgroup.com", { has: ["chat_read"] }), row(B, "robert@pub-k.org")];
    const s = setup({ rows });
    expect((await s.routes.callLink(postReq("call-link", { conn: A, chat: KEY, video: false }), "PKG")).status).toBe(409);
    expect((await s.routes.callLink(postReq("call-link", { conn: B, chat: KEY, video: false }), "PKG")).status).toBe(200);
    expect(reader.resolveCallTargets).toHaveBeenCalledTimes(1);
    expect(reader.resolveCallTargets.mock.calls[0]?.[1]).toBe(B);
  });

  it("the read marker is written for the account named in the body only", async () => {
    const s = setup();
    expect((await s.routes.read(postReq("read", { conn: B, chat: KEY, readThrough: T(2) }), "PKG")).status).toBe(204);
    const marks = s.rpc.filter((r) => r.fn === "teams_chat_read_mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.args).toMatchObject({ p_lane: "PKG", p_connection: B });
  });
});

describe("the combined chat list route (tests 30, 31)", () => {
  it("without `conn` it reads every usable account once (Refresh); with `conn` only that account (after a notice); markers in ONE query either way", async () => {
    const s = setup();
    expect((await s.routes.chats(getReq("chats", ""), "PKG")).status).toBe(200);
    expect(reader.listChats.mock.calls.map((c) => c[1]).sort()).toEqual([A, B]);
    expect(s.rpc.filter((r) => r.fn === "teams_chat_reads_list_many")).toHaveLength(1);
    expect(s.rpc.filter((r) => r.fn === "teams_chat_reads_list_many")[0]?.args).toEqual({ p_lane: "PKG", p_connections: [A, B] });
    reader.listChats.mockClear();
    s.rpc.length = 0;
    expect((await s.routes.chats(getReq("chats", `conn=${B}`), "PKG")).status).toBe(200);
    expect(reader.listChats.mock.calls.map((c) => c[1])).toEqual([B]);
    expect(s.rpc.filter((r) => r.fn === "teams_chat_reads_list_many")[0]?.args).toEqual({ p_lane: "PKG", p_connections: [B] });
  });

  it("the rows carry their account label and connection; an account that failed is a note and the answer is still 200; every account failing is the failure status", async () => {
    reader.listChats.mockImplementation(async (_l: string, conn: string) => {
      if (conn === A) throw { info: { kind: "reconnect_required", message: "secret" } };
      return { chats: [{ chatId: CHAT, chatType: "group", topic: "T", webUrl: null, members: [], membersCapped: false, lastReadAt: null, hidden: false, preview: { createdAt: T(3), senderId: "u", senderName: "Pat", mine: false, text: "hi", deleted: false, system: false } }], nextCursor: null, self: {} };
    });
    const s = setup();
    const res = await s.routes.chats(getReq("chats", ""), "PKG");
    expect(res.status).toBe(200);
    const b = (await res.json()) as { rows: { conn: string; account: string }[]; notes: { conn: string; kind: string }[]; listed: string[] };
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]).toMatchObject({ conn: B, account: "pub-k.org" });
    expect(b.notes).toEqual([{ conn: A, label: "pubkgroup.com", kind: "reconnect", seconds: null }]);
    expect(b.listed).toEqual([B]);
    expect(JSON.stringify(b)).not.toContain("secret");
    reader.listChats.mockRejectedValue({ info: { kind: "reconnect_required" } });
    expect((await s.routes.chats(getReq("chats", ""), "PKG")).status).toBe(409);
  });

  it("`more` is the combined cursor (or one old token for one account); a hostile value is 400 and no read happens; a cursor naming a foreign connection drops that entry", async () => {
    const s = setup();
    for (const bad of ["!!!", "a b", "x".repeat(6401), Buffer.from(JSON.stringify({ v: 1, s: [{ c: "nope", k: "t" }] })).toString("base64url")]) expect((await s.routes.chats(getReq("chats", `more=${encodeURIComponent(bad)}`), "PKG")).status, bad.slice(0, 20)).toBe(400);
    expect((await s.routes.chats(getReq("chats", "more=oldSingleToken"), "PKG")).status).toBe(400); // two accounts: an old single token is not a cursor
    expect(reader.listChats).not.toHaveBeenCalled();
    const cursor = encodeCursor([{ conn: A, token: "tokA" }, { conn: OTHER_PERSON, token: "tokX" }]) as string;
    const res = await s.routes.chats(getReq("chats", `more=${cursor}`), "PKG");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dropped: boolean }).dropped).toBe(true);
    expect(reader.listChats.mock.calls.map((c) => [c[1], c[3]])).toEqual([[A, { cursor: "tokA", memberReads: 20 }]]);
    expect(decodeCursor(cursor)?.length).toBe(2);
  });

  it("the per-person limiter is not doubled by a second account: one Refresh is ONE request to our server however many accounts it reads", async () => {
    const rows = ROWS;
    const limiter = createWindowLimiter(2, 60_000);
    const deps: TeamsRouteDeps = {
      guards: async () => ({ requireLane: async () => ({ client: { schema: () => ({ rpc: async () => ({ data: [], error: null }) }) }, session: { userId: ME } }) as never, requireRole: async () => ({ client: { schema: () => ({ rpc: async () => ({ data: [], error: null }) }) }, session: { userId: ME } }) as never }),
      gate: async () => ({ limited: false, newsShown: true, visible: () => true }),
      rows: async () => rows as never,
      limiters: { activity: createWindowLimiter(100, 60_000), reads: limiter },
    };
    const routes = createTeamsRoutes(deps);
    expect((await routes.chats(getReq("chats", ""), "PKG")).status).toBe(200);
    expect((await routes.chats(getReq("chats", ""), "PKG")).status).toBe(200);
    expect((await routes.chats(getReq("chats", ""), "PKG")).status).toBe(429);
    expect(reader.listChats).toHaveBeenCalledTimes(4); // two reads each, but the allowance counted requests
  });
});

describe("notices of several accounts (test 32)", () => {
  const live = (lastNotice: string, seen: string | null, until = T(50)) => ({ live: true, live_until: until, last_notice_at: lastNotice, last_seen_at: seen });

  it("the answer holds an entry per usable account and the aggregate: live = any, liveUntil = the earliest of the live ones, dot = any, lastNoticeAt = the latest; Microsoft is never asked", async () => {
    const s = setup({ activity: { [A]: live(T(10), T(5), T(60)), [B]: live(T(20), T(25), T(40)) } });
    const b = (await (await s.routes.activity(getReq("activity", ""), "PKG")).json()) as Record<string, unknown>;
    expect(b).toMatchObject({ live: true, liveUntil: T(40), dot: true, lastNoticeAt: T(20) });
    expect(b.accounts).toEqual([
      { conn: A, live: true, liveUntil: T(60), dot: true, lastNoticeAt: T(10) },
      { conn: B, live: true, liveUntil: T(40), dot: false, lastNoticeAt: T(20) },
    ]);
    expect(s.rpc.map((r) => `${r.fn}:${String(r.args.p_connection)}`).sort()).toEqual([`teams_activity_get:${A}`, `teams_activity_get:${B}`]);
    expect(everyReaderCall()).toEqual([]);
  });

  it("a person with no usable account still gets live false with 200; an account whose sign-in expired has no entry; another person's account is never asked about", async () => {
    const none = setup({ rows: [row(A, "a@x.test", { state: "reconnect_required" }), row(OTHER_PERSON, "x@y.test", { mine: false })] });
    expect(await (await none.routes.activity(getReq("activity", ""), "PKG")).json()).toMatchObject({ live: false, dot: false, accounts: [] });
    expect(none.rpc).toEqual([]);
  });

  it("'seen' marks only the named accounts (an id that fails is dropped, not an error); without a body every usable account; a malformed body is 400; a database refusal is 409", async () => {
    const s = setup();
    expect((await s.routes.seen(postReq("activity", { conns: [B, OTHER_PERSON, UNKNOWN, "junk"] }), "PKG")).status).toBe(200);
    expect(s.rpc.filter((r) => r.fn === "teams_activity_seen").map((r) => r.args.p_connection)).toEqual([B]);
    s.rpc.length = 0;
    expect((await s.routes.seen(new Request(url("activity"), { method: "POST", headers: SAME }), "PKG")).status).toBe(200);
    expect(s.rpc.filter((r) => r.fn === "teams_activity_seen").map((r) => r.args.p_connection).sort()).toEqual([A, B]);
    s.rpc.length = 0;
    for (const bad of ["not json", JSON.stringify({ conns: [] }), JSON.stringify({ conns: "x" }), JSON.stringify({ conns: [A], extra: 1 }), JSON.stringify({ conns: [A, A, A, A, A, A] }), "[]"]) expect((await s.routes.seen(postReq("activity", bad), "PKG")).status, bad).toBe(400);
    expect(s.rpc.filter((r) => r.fn === "teams_activity_seen")).toEqual([]);
    expect((await setup({ seenFail: [B] }).routes.seen(postReq("activity", { conns: [B] }), "PKG")).status).toBe(409);
  });
});

describe("review fixes: the open account of a re-read (M1) and the canary on the routes (M4)", () => {
  const SHARED_ID = "19:shared111@thread.v2";
  const SHARED_KEY = encodeChatKey(SHARED_ID);
  const listOf = () => ({ chats: [{ chatId: SHARED_ID, chatType: "group", topic: "T", webUrl: null, members: [], membersCapped: false, lastReadAt: null, hidden: false, preview: { createdAt: T(3), senderId: "u", senderName: "Pat", mine: false, text: "hi", deleted: false, system: false } }], nextCursor: null, self: {} });

  it("`open` names the account of the open chat: re-reading B's list keeps B's row unread-free only for B; A's row of the same chat keeps its dot", async () => {
    reader.listChats.mockResolvedValue(listOf());
    const s = setup();
    const b = (await (await s.routes.chats(getReq("chats", `chat=${SHARED_KEY}&open=${A}`), "PKG")).json()) as { rows: { conn: string; unread: boolean }[] };
    expect(b.rows.map((r) => [r.conn, r.unread])).toEqual([[A, false], [B, true]]);
    // the per-account re-read after a notice carries `open` too
    const one = (await (await s.routes.chats(getReq("chats", `conn=${B}&chat=${SHARED_KEY}&open=${A}`), "PKG")).json()) as { rows: { conn: string; unread: boolean }[] };
    expect(one.rows.map((r) => [r.conn, r.unread])).toEqual([[B, true]]);
  });

  it("`open` is validated exactly like `conn`: another person's, another lane's, a disconnected, a pending and an unknown id are the same 404 with zero reader calls; a non-uuid is 400", async () => {
    const s = setup();
    const bodies = new Set<string>();
    for (const id of [OTHER_PERSON, OTHER_LANE, DISCONNECTED, PENDING, UNKNOWN]) {
      const res = await s.routes.chats(getReq("chats", `chat=${SHARED_KEY}&open=${id}`), "PKG");
      expect(res.status, id).toBe(404);
      bodies.add(await res.text());
    }
    expect(bodies).toEqual(new Set([JSON.stringify({ error: "not_found" })]));
    for (const bad of ["../x", "nope", A.toUpperCase()]) expect((await s.routes.chats(getReq("chats", `chat=${SHARED_KEY}&open=${bad}`), "PKG")).status, bad).toBe(400);
    expect(everyReaderCall()).toEqual([]);
  });

  it("M4: a canary in a preview, a message body and a member name reaches no database write and no log line through the list, a partial failure, 'More chats' and an activity read", async () => {
    const CANARY = "canary-chat-content-9a1f-not-real";
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    reader.listChats.mockImplementation(async (_l: string, conn: string) => {
      if (conn === B) throw { info: { kind: "rate_limited", retry_after_seconds: 3, message: `secret ${CANARY}` } };
      return { chats: [{ chatId: SHARED_ID, chatType: "group", topic: `Topic ${CANARY}`, webUrl: null, members: [{ userId: null, displayName: `Pat ${CANARY}`, tenantId: "t", external: false, self: false }], membersCapped: false, lastReadAt: null, hidden: false, preview: { createdAt: T(3), senderId: "u", senderName: `Pat ${CANARY}`, mine: false, text: `Hello ${CANARY}`, deleted: false, system: false } }], nextCursor: "tokA", self: {} };
    });
    reader.listMessages.mockResolvedValue({ messages: [{ id: "1700000000001", createdAt: T(1), modifiedAt: T(1), edited: false, deleted: false, system: false, sender: { id: "u", name: `Pat ${CANARY}`, kind: "user" }, mine: false, nodes: [{ t: "text", v: `Body ${CANARY}` }], truncated: false, attachments: [] }], nextBefore: null });
    const s = setup();
    const first = (await (await s.routes.chats(getReq("chats", ""), "PKG")).json()) as { moreCursor: string; notes: unknown[] };
    await s.routes.chats(getReq("chats", `more=${first.moreCursor}`), "PKG");
    await s.routes.newer(getReq("newer", `conn=${A}&chat=${SHARED_KEY}&since=${T(0)}`), "PKG");
    await s.routes.activity(getReq("activity", ""), "PKG");
    expect(Buffer.from(first.moreCursor, "base64url").toString("utf8")).not.toContain(CANARY);
    expect(JSON.stringify(first.notes)).not.toContain(CANARY);
    // the portal's own database is only READ (markers, activity); nothing from a chat is written
    expect(s.rpc.every((r) => ["teams_chat_reads_list_many", "teams_activity_get"].includes(r.fn))).toBe(true);
    expect(JSON.stringify(s.rpc)).not.toContain(CANARY);
    for (const sp of spies) expect(JSON.stringify(sp.mock.calls)).not.toContain(CANARY);
    for (const sp of spies) sp.mockRestore();
  });
});
