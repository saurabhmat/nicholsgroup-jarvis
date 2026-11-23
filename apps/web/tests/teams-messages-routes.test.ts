// The three routes behind the Messages page (T-283, T-284): same site, lane, AAL2 + own_mail, the `messages` module, the person's OWN usable Teams connection (another person's row, even
// an admin's view of it, is never used: the routes take no connection id at all), valid chat keys and times, fixed JSON answers, no store. The Teams reader is faked; its rules are tested in packages/connectors.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";

const reader = vi.hoisted(() => ({ resolveCallTargets: vi.fn(), listMessages: vi.fn() }));
vi.mock("@nichols/connectors/teams-reader", () => ({ resolveCallTargets: reader.resolveCallTargets, listMessages: reader.listMessages, listChats: vi.fn(), openChat: vi.fn() }));

import { createTeamsRoutes, type TeamsRouteDeps } from "@/lib/teams-api";
import { encodeChatKey } from "@/lib/teams-chat-key";

const ME = "00000000-0000-4000-8000-0000000000aa";
const CONN = "00000000-0000-4000-8000-0000000000c1";
const OTHER_CONN = "00000000-0000-4000-8000-0000000000c2";
const CHAT = "19:abc123def456@thread.v2";
const KEY = encodeChatKey(CHAT);
const row = (over: Record<string, unknown> = {}) => ({ id: CONN, account: "me@teams.example.test", state: "connected", mine: true, has: ["chat_read", "call_links"], ...over });

type Calls = { rpc: { fn: string; args: Record<string, unknown> }[]; roles: unknown[] };
function setup(opts: { rows?: unknown[]; gateVisible?: boolean; rpcError?: unknown; laneError?: unknown; roleError?: unknown } = {}) {
  const calls: Calls = { rpc: [], roles: [] };
  const client = { schema: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => (calls.rpc.push({ fn, args }), { data: null, error: opts.rpcError ?? null }) }) };
  const deps: TeamsRouteDeps = {
    guards: async () => ({
      requireLane: async () => {
        if (opts.laneError) throw opts.laneError;
        return { client, session: { userId: ME } } as never;
      },
      requireRole: async (_l: unknown, roles: unknown) => {
        calls.roles.push(roles);
        if (opts.roleError) throw opts.roleError;
        return { client, session: { userId: ME } } as never;
      },
    }),
    gate: async () => ({ limited: false, newsShown: true, visible: () => opts.gateVisible !== false }),
    rows: async () => (opts.rows ?? [row()]) as never,
  };
  return { routes: createTeamsRoutes(deps), calls };
}
const SITE = { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" };
const post = (path: string, body: unknown, headers: Record<string, string> = SITE) => new Request(`http://localhost:3000/api/lanes/PKG/messages/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const get = (qs: string, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) => new Request(`http://localhost:3000/api/lanes/PKG/messages/older?${qs}`, { headers });

beforeEach(() => {
  reader.resolveCallTargets.mockReset();
  reader.listMessages.mockReset();
});

describe("who may call the routes", () => {
  it("cross-site, a bad lane and no session are refused before anything is read", async () => {
    const { routes, calls } = setup();
    expect((await routes.callLink(post("call-link", { chat: KEY, video: false }, { origin: "https://evil.example.test" }), "PKG")).status).toBe(403);
    expect((await routes.callLink(post("call-link", { chat: KEY, video: false }, { origin: "http://localhost:3000", "sec-fetch-site": "cross-site" }), "PKG")).status).toBe(403);
    expect((await routes.read(post("read", { chat: KEY, readThrough: "2026-11-23T14:00:00Z" }, {}), "PKG")).status).toBe(403); // no Origin at all on a POST
    expect((await routes.older(get(`chat=${KEY}&before=2026-11-23T14:00:00Z`, { "sec-fetch-site": "cross-site" }), "PKG")).status).toBe(403);
    expect((await routes.callLink(post("call-link", { chat: KEY, video: false }), "pkg")).status).toBe(404);
    expect((await routes.callLink(post("call-link", { chat: KEY, video: false }), "../x")).status).toBe(404);
    expect(calls.roles).toEqual([]);
    expect(reader.resolveCallTargets).not.toHaveBeenCalled();
  });

  it("a lane that is not the caller's is a 404; no session is a 401; AAL1 or a role without own_mail is a 403", async () => {
    expect((await setup({ laneError: new AuthError("forbidden") }).routes.callLink(post("call-link", { chat: KEY, video: false }), "PKG")).status).toBe(404);
    expect((await setup({ roleError: new AuthError("no_session") }).routes.callLink(post("call-link", { chat: KEY, video: false }), "PKG")).status).toBe(401);
    expect((await setup({ roleError: new AuthError("mfa_required") }).routes.callLink(post("call-link", { chat: KEY, video: false }), "PKG")).status).toBe(403);
    expect((await setup({ roleError: new AuthError("forbidden") }).routes.callLink(post("call-link", { chat: KEY, video: false }), "PKG")).status).toBe(403);
    expect(reader.resolveCallTargets).not.toHaveBeenCalled();
  });

  it("the own_mail roles are asked for; a company that hides Messages answers 404", async () => {
    const a = setup();
    reader.resolveCallTargets.mockResolvedValue({ ok: true, upns: ["pat@teams.example.test"] });
    await a.routes.callLink(post("call-link", { chat: KEY, video: false }), "PKG");
    expect(a.calls.roles).toEqual([["owner", "admin_technical", "viewer"]]);
    expect((await setup({ gateVisible: false }).routes.callLink(post("call-link", { chat: KEY, video: false }), "PKG")).status).toBe(404);
  });

  it("only the person's OWN usable Teams connection is used: another person's row (an admin sees its health), a paused or reconnect row, or none, is a 404 and no Graph call", async () => {
    for (const rows of [[], [row({ id: OTHER_CONN, mine: false })], [row({ state: "reconnect_required" })], [row({ state: "paused" })]]) {
      const { routes } = setup({ rows });
      expect((await routes.callLink(post("call-link", { chat: KEY, video: false }), "PKG")).status).toBe(404);
      expect((await routes.older(get(`chat=${KEY}&before=2026-11-23T14:00:00Z`), "PKG")).status).toBe(404);
      expect((await routes.read(post("read", { chat: KEY, readThrough: "2026-11-23T14:00:00Z" }), "PKG")).status).toBe(404);
    }
    expect(reader.resolveCallTargets).not.toHaveBeenCalled();
    expect(reader.listMessages).not.toHaveBeenCalled();
    // a connection id in the request is ignored: the person's own row is the only one ever passed on
    const { routes } = setup({ rows: [row({ id: OTHER_CONN, mine: false }), row()] });
    reader.resolveCallTargets.mockResolvedValue({ ok: true, upns: ["pat@teams.example.test"] });
    await routes.callLink(post("call-link", { chat: KEY, video: false, connectionId: OTHER_CONN, connection: OTHER_CONN }), "PKG");
    expect(reader.resolveCallTargets).toHaveBeenCalledWith("PKG", CONN, ME, CHAT);
  });
});

describe("POST call-link", () => {
  it("returns the https call link, built from validated values; Video adds withVideo; nothing is stored", async () => {
    const { routes, calls } = setup();
    reader.resolveCallTargets.mockResolvedValue({ ok: true, upns: ["pat@teams.example.test"] });
    const a = await routes.callLink(post("call-link", { chat: KEY, video: false }), "PKG");
    expect(a.status).toBe(200);
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(await a.json()).toEqual({ url: "https://teams.microsoft.com/l/call/0/0?users=pat@teams.example.test" });
    const b = await routes.callLink(post("call-link", { chat: KEY, video: true }), "PKG");
    expect(await b.json()).toEqual({ url: "https://teams.microsoft.com/l/call/0/0?users=pat@teams.example.test&withVideo=true" });
    expect(calls.rpc).toEqual([]); // no database write of any kind
  });

  it("an external member, too many people, nobody else: 409 with the reason, no link", async () => {
    for (const reason of ["external", "too_many", "no_one", "unresolved"]) {
      reader.resolveCallTargets.mockResolvedValueOnce({ ok: false, reason });
      const r = await setup().routes.callLink(post("call-link", { chat: KEY, video: false }), "PKG");
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "not_allowed", reason });
    }
  });

  it("a connection without call buttons is 'feature_missing' and the reader is not called", async () => {
    const r = await setup({ rows: [row({ has: ["chat_read"] })] }).routes.callLink(post("call-link", { chat: KEY, video: false }), "PKG");
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "feature_missing" });
    expect(reader.resolveCallTargets).not.toHaveBeenCalled();
  });

  it("a made-up chat key, a missing or non-boolean video flag, a huge or malformed body: 400, no reader call", async () => {
    const { routes } = setup();
    for (const body of [{ chat: "nope", video: false }, { chat: KEY }, { chat: KEY, video: "yes" }, { video: true }, "not json", "[]", "null", JSON.stringify({ chat: KEY, video: false, pad: "x".repeat(5000) }), ""]) {
      expect((await routes.callLink(post("call-link", body), "PKG")).status, String(body).slice(0, 30)).toBe(400);
    }
    expect(reader.resolveCallTargets).not.toHaveBeenCalled();
  });

  it("Microsoft failures are fixed codes: 429 busy with Retry-After, reconnect 409, forbidden 403, else 503; nothing from the error is passed on", async () => {
    const run = async (info: Record<string, unknown>) => {
      reader.resolveCallTargets.mockRejectedValueOnce({ info: { ...info, message: "secret chat text canary-xyz" } });
      const r = await setup().routes.callLink(post("call-link", { chat: KEY, video: false }), "PKG");
      const text = await r.clone().text();
      expect(text).not.toContain("canary-xyz");
      return r;
    };
    const busy = await run({ kind: "rate_limited", retry_after_seconds: 7 });
    expect([busy.status, busy.headers.get("retry-after"), await busy.json()]).toEqual([429, "7", { error: "busy", seconds: 7 }]);
    expect((await run({ kind: "reconnect_required" })).status).toBe(409);
    expect((await run({ kind: "forbidden" })).status).toBe(403);
    expect((await run({ kind: "timeout" })).status).toBe(503);
  });

  it("an unexpected error is a 503 and the log line holds the class only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { routes } = setup({ rows: undefined });
    reader.resolveCallTargets.mockImplementation(() => {
      throw new TypeError("secret chat text canary-xyz");
    });
    const r = await routes.callLink(post("call-link", { chat: KEY, video: false }), "PKG");
    expect(r.status).toBe(503);
    expect(JSON.stringify(log.mock.calls)).not.toContain("canary-xyz");
    log.mockRestore();
  });
});

describe("POST read (the portal's own marker)", () => {
  it("records the marker for the person's own connection through their own lane client (core wrapper); 204", async () => {
    const { routes, calls } = setup();
    const r = await routes.read(post("read", { chat: KEY, readThrough: "2026-11-23T14:05:00.1234567Z" }), "PKG");
    expect(r.status).toBe(204);
    expect(calls.rpc).toEqual([{ fn: "teams_chat_read_mark", args: { p_lane: "PKG", p_connection: CONN, p_chat: CHAT, p_read_through: "2026-11-23T14:05:00.123Z" } }]);
  });
  it("a database refusal is 409 'not_recorded'; a bad key or time is 400 and nothing is written", async () => {
    expect((await setup({ rpcError: { code: "P0002" } }).routes.read(post("read", { chat: KEY, readThrough: "2026-11-23T14:05:00Z" }), "PKG")).status).toBe(409);
    const { routes, calls } = setup();
    for (const body of [{ chat: "x", readThrough: "2026-11-23T14:05:00Z" }, { chat: KEY, readThrough: "yesterday" }, { chat: KEY }, { readThrough: "2026-11-23T14:05:00Z" }, "x"]) expect((await routes.read(post("read", body), "PKG")).status).toBe(400);
    expect(calls.rpc).toEqual([]);
  });
});

describe("GET older", () => {
  it("one more page before a time; the answer holds messages and the next time; no store", async () => {
    const { routes, calls } = setup();
    reader.listMessages.mockResolvedValue({ messages: [{ id: "m1", createdAt: "2026-11-23T13:00:00.000Z", modifiedAt: null, edited: false, deleted: false, system: false, sender: { id: null, name: "Pat", kind: "user" }, mine: false, nodes: [{ t: "text", v: "hi" }], truncated: false, attachments: [] }], nextBefore: "2026-11-23T13:00:00.000Z", self: { tenantId: "t", entraObjectId: ME } });
    const r = await routes.older(get(`chat=${KEY}&before=2026-11-23T14:00:00Z`), "PKG");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const b = (await r.json()) as { messages: { id: string; nodes: unknown }[]; nextBefore: string };
    expect(b.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(b.nextBefore).toBe("2026-11-23T13:00:00.000Z");
    expect(reader.listMessages).toHaveBeenCalledWith("PKG", CONN, ME, CHAT, { before: "2026-11-23T14:00:00.000Z" });
    expect(calls.rpc).toEqual([]);
  });
  it("a made-up chat key or time is 400 and Graph is not called; Teams being busy is 429 with Retry-After", async () => {
    const { routes } = setup();
    for (const qs of ["", `chat=${KEY}`, "before=2026-11-23T14:00:00Z", "chat=x&before=2026-11-23T14:00:00Z", `chat=${KEY}&before=%27%20or%20true`]) expect((await routes.older(get(qs), "PKG")).status, qs).toBe(400);
    expect(reader.listMessages).not.toHaveBeenCalled();
    reader.listMessages.mockRejectedValue({ info: { kind: "rate_limited", retry_after_seconds: 4 } });
    const r = await routes.older(get(`chat=${KEY}&before=2026-11-23T14:00:00Z`), "PKG");
    expect([r.status, r.headers.get("retry-after")]).toEqual([429, "4"]);
  });
});

describe("SL3: the request body is read with a hard cap", () => {
  it("a declared length over the cap is refused without reading; a stream that passes the cap is cut; a body at the cap is read", async () => {
    const { routes } = setup();
    reader.resolveCallTargets.mockResolvedValue({ ok: true, upns: ["pat@teams.example.test"] });
    const big = new Request("http://localhost:3000/api/lanes/PKG/messages/call-link", { method: "POST", headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "content-length": "999999" }, body: JSON.stringify({ chat: KEY, video: false }) });
    expect((await routes.callLink(big, "PKG")).status).toBe(400);
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(1000));
    const stream = new ReadableStream({ pull(c) { pulled += 1; if (pulled > 50) c.close(); else c.enqueue(chunk); } });
    const endless = new Request("http://localhost:3000/api/lanes/PKG/messages/call-link", { method: "POST", headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }, body: stream, duplex: "half" } as RequestInit);
    expect((await routes.callLink(endless, "PKG")).status).toBe(400);
    expect(pulled).toBeLessThan(10); // stopped soon after the 2,000-byte cap
    expect(reader.resolveCallTargets).not.toHaveBeenCalled();
    expect((await routes.callLink(post("call-link", { chat: KEY, video: false }), "PKG")).status).toBe(200);
  });
});
