// The routes behind the live Messages page (T-290, spec 9.4): `/messages/activity` (GET the notice state, POST seen), `/messages/chats` and `/messages/newer`. Same checks as the other Messages routes
// (same site, lane, AAL2 + own_mail, the `messages` module, the person's OWN usable connection), the activity route reads the DATABASE ONLY (the Teams reader is never called), answers only a boolean and
// times, never caches, and is rate limited per person; the two re-read routes ask Microsoft with a date range and have their own, smaller, per-person allowance. Synthetic data only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";

const reader = vi.hoisted(() => ({ listMessages: vi.fn(), listChats: vi.fn(), openChat: vi.fn(), resolveCallTargets: vi.fn() }));
vi.mock("@nichols/connectors/teams-reader", () => ({ ...reader }));

import { createTeamsRoutes, type TeamsRouteDeps } from "@/lib/teams-api";
import { createWindowLimiter } from "@/lib/teams-activity";
import { encodeChatKey } from "@/lib/teams-chat-key";

const ME = "00000000-0000-4000-8000-0000000000aa";
const CONN = "00000000-0000-4000-8000-0000000000c1";
const OTHER_CONN = "00000000-0000-4000-8000-0000000000c2";
const CHAT = "19:abc123def456@thread.v2";
const KEY = encodeChatKey(CHAT);
const row = (over: Record<string, unknown> = {}) => ({ id: CONN, account: "me@teams.example.test", state: "connected", mine: true, has: ["chat_read", "call_links"], ...over });
/** The answer without the server's clock (which must be there, as a time). */
const noClock = (b: unknown) => {
  const { serverNow, ...rest } = b as Record<string, unknown>;
  expect(Number.isNaN(Date.parse(String(serverNow)))).toBe(false);
  return rest;
};
const T = (m: number) => new Date(Date.UTC(2026, 10, 23, 15, m)).toISOString();

type Rec = { fn: string; args: Record<string, unknown> };
function setup(opts: { rows?: unknown[]; gateVisible?: boolean; get?: unknown; seenError?: unknown; getError?: unknown; laneError?: unknown; roleError?: unknown; limiters?: TeamsRouteDeps["limiters"]; defaultLimiters?: boolean } = {}) {
  const rpc: Rec[] = [];
  const roles: unknown[] = [];
  const client = {
    schema: (s: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpc.push({ fn: `${s}.${fn}`, args });
        if (fn === "teams_activity_get") return { data: opts.get ?? [{ live: true, live_until: T(50), last_notice_at: T(10), last_seen_at: T(5) }], error: opts.getError ?? null };
        if (fn === "teams_activity_seen") return { data: T(11), error: opts.seenError ?? null };
        if (fn === "teams_chat_reads_list") return { data: [], error: null };
        return { data: null, error: null };
      },
    }),
  };
  const deps: TeamsRouteDeps = {
    guards: async () => ({
      requireLane: async () => {
        if (opts.laneError) throw opts.laneError;
        return { client, session: { userId: ME } } as never;
      },
      requireRole: async (_l: unknown, r: unknown) => {
        roles.push(r);
        if (opts.roleError) throw opts.roleError;
        return { client, session: { userId: ME } } as never;
      },
    }),
    gate: async () => ({ limited: false, newsShown: true, visible: () => opts.gateVisible !== false }),
    rows: async () => (opts.rows ?? [row()]) as never,
    ...(opts.defaultLimiters ? {} : opts.limiters ? { limiters: opts.limiters } : { limiters: { activity: createWindowLimiter(20, 60_000), reads: createWindowLimiter(12, 60_000) } }),
  };
  return { routes: createTeamsRoutes(deps), rpc, roles };
}
const SITE = { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" };
const req = (path: string, method: "GET" | "POST" = "GET", headers: Record<string, string> = SITE) => new Request(`http://localhost:3000/api/lanes/PKG/messages/${path}`, { method, headers });
const nothingFromMicrosoft = () => {
  for (const f of Object.values(reader)) expect(f).not.toHaveBeenCalled();
};

beforeEach(() => {
  for (const f of Object.values(reader)) f.mockReset();
});

describe("GET /messages/activity", () => {
  it("answers the state of the person's OWN connection from the database only, as a boolean and times: no chat, no connection id, no count", async () => {
    const s = setup();
    const res = await s.routes.activity(req("activity"), "PKG");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(noClock(body)).toEqual({ live: true, liveUntil: T(50), dot: true, lastNoticeAt: T(10) });
    expect(Object.keys(body).sort()).toEqual(["dot", "lastNoticeAt", "live", "liveUntil", "serverNow"]);
    expect(JSON.stringify(body)).not.toContain(CONN);
    // exactly one database call, with the lane and the person's own connection; Microsoft is never touched
    expect(s.rpc).toEqual([{ fn: "core.teams_activity_get", args: { p_lane: "PKG", p_connection: CONN } }]);
    nothingFromMicrosoft();
  });

  it("the dot is: a notice newer than the last time the chat list was opened, with notices on", async () => {
    const dot = async (get: unknown) => ((await (await setup({ get }).routes.activity(req("activity"), "PKG")).json()) as { dot: boolean }).dot;
    expect(await dot([{ live: true, live_until: T(50), last_notice_at: T(10), last_seen_at: T(5) }])).toBe(true);
    expect(await dot([{ live: true, live_until: T(50), last_notice_at: T(10), last_seen_at: T(10) }])).toBe(false);
    expect(await dot([{ live: true, live_until: T(50), last_notice_at: T(10), last_seen_at: T(20) }])).toBe(false);
    expect(await dot([{ live: true, live_until: T(50), last_notice_at: T(10), last_seen_at: null }])).toBe(true);
    expect(await dot([{ live: true, live_until: T(50), last_notice_at: null, last_seen_at: T(5) }])).toBe(false);
    expect(await dot([{ live: false, live_until: null, last_notice_at: T(10), last_seen_at: T(5) }])).toBe(false); // notices are off: no dot
  });

  it("no usable Teams connection, a row the database does not return (not the owner) or notices off: `live: false`, no dot, 200 (a missing dot is not an error)", async () => {
    for (const s of [setup({ rows: [] }), setup({ rows: [row({ id: OTHER_CONN, mine: false })] }), setup({ rows: [row({ state: "reconnect_required" })] }), setup({ get: [] }), setup({ get: [{ live: false, live_until: null, last_notice_at: null, last_seen_at: null }] })]) {
      const res = await s.routes.activity(req("activity"), "PKG");
      expect(res.status).toBe(200);
      expect(noClock(await res.json())).toEqual({ live: false, liveUntil: null, dot: false, lastNoticeAt: null });
    }
    // another person's connection (an admin sees its health) is never even asked about
    const s = setup({ rows: [row({ id: OTHER_CONN, mine: false })] });
    await s.routes.activity(req("activity"), "PKG");
    expect(s.rpc).toEqual([]);
  });

  it("the same checks as the other Messages routes: cross-site, a bad lane, no session, MFA, no own_mail, a lane that is not theirs, a hidden module", async () => {
    expect((await setup().routes.activity(req("activity", "GET", { "sec-fetch-site": "cross-site" }), "PKG")).status).toBe(403);
    expect((await setup().routes.activity(req("activity"), "pkg")).status).toBe(404);
    expect((await setup().routes.activity(req("activity"), "../x")).status).toBe(404);
    expect((await setup({ roleError: new AuthError("no_session") }).routes.activity(req("activity"), "PKG")).status).toBe(401);
    expect((await setup({ roleError: new AuthError("mfa_required") }).routes.activity(req("activity"), "PKG")).status).toBe(403);
    expect((await setup({ roleError: new AuthError("forbidden") }).routes.activity(req("activity"), "PKG")).status).toBe(403);
    expect((await setup({ laneError: new AuthError("forbidden") }).routes.activity(req("activity"), "PKG")).status).toBe(404);
    expect((await setup({ gateVisible: false }).routes.activity(req("activity"), "PKG")).status).toBe(404);
    const a = setup();
    await a.routes.activity(req("activity"), "PKG");
    expect(a.roles).toEqual([["owner", "admin_technical", "viewer"]]);
    nothingFromMicrosoft();
  });

  it("a database error is 503 with a fixed body, never `no activity`; no detail leaks", async () => {
    const s = setup({ getError: { code: "XX000", message: "secret db text" } });
    const res = await s.routes.activity(req("activity"), "PKG");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toContain("secret db text");
  });

  it("is rate limited per person (and lane): the 21st request in a minute is a 429 with Retry-After; another person is not affected; the limit answers before the company or connection is read", async () => {
    let t = 0;
    const limiters = { activity: createWindowLimiter(3, 60_000, () => t), reads: createWindowLimiter(12, 60_000, () => t) };
    const s = setup({ limiters });
    for (let i = 0; i < 3; i++) expect((await s.routes.activity(req("activity"), "PKG")).status).toBe(200);
    const before = s.rpc.length;
    const res = await s.routes.activity(req("activity"), "PKG");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect(s.rpc.length).toBe(before); // the database was not asked
    t = 61_000;
    expect((await s.routes.activity(req("activity"), "PKG")).status).toBe(200);
    // the activity limiter is shared by GET and POST (one allowance per person)
    for (let i = 0; i < 2; i++) await s.routes.seen(req("activity", "POST"), "PKG");
    expect((await s.routes.seen(req("activity", "POST"), "PKG")).status).toBe(429);
  });

  it("the default limiter allows a poll every 30 seconds from several tabs and a dot, and refuses a runaway", async () => {
    const s = setup({ defaultLimiters: true });
    let ok = 0;
    for (let i = 0; i < 30; i++) if ((await s.routes.activity(req("activity"), "PKG")).status === 200) ok += 1;
    expect(ok).toBe(20);
  });
});

describe("POST /messages/activity (the chat list was opened)", () => {
  it("records `teams_activity_seen` for the person's own connection (same site, with an Origin) and answers the state afterwards", async () => {
    const s = setup({ get: [{ live: true, live_until: T(50), last_notice_at: T(10), last_seen_at: T(11) }] });
    const res = await s.routes.seen(req("activity", "POST"), "PKG");
    expect(res.status).toBe(200);
    expect(noClock(await res.json())).toEqual({ live: true, liveUntil: T(50), dot: false, lastNoticeAt: T(10) });
    expect(s.rpc.map((r) => r.fn)).toEqual(["core.teams_activity_seen", "core.teams_activity_get"]);
    expect(s.rpc[0]?.args).toEqual({ p_lane: "PKG", p_connection: CONN });
    nothingFromMicrosoft();
  });

  it("cross-site, no Origin, no connection, the database refusing: 403 / `live false` / 409", async () => {
    expect((await setup().routes.seen(req("activity", "POST", {}), "PKG")).status).toBe(403);
    expect((await setup().routes.seen(req("activity", "POST", { origin: "https://evil.example.test", "sec-fetch-site": "same-origin" }), "PKG")).status).toBe(403);
    const none = setup({ rows: [] });
    expect(noClock(await (await none.routes.seen(req("activity", "POST"), "PKG")).json())).toEqual({ live: false, liveUntil: null, dot: false, lastNoticeAt: null });
    expect(none.rpc).toEqual([]);
    const refused = setup({ seenError: { code: "P0002" } });
    expect((await refused.routes.seen(req("activity", "POST"), "PKG")).status).toBe(409);
  });
});

describe("GET /messages/chats and /messages/newer (the re-reads)", () => {
  it("the chat list again: the page's own read for the person's connection with the selected chat and cursor passed through; one answer, rows and the next cursor only", async () => {
    reader.listChats.mockResolvedValue({ chats: [], nextCursor: "abc" });
    const s = setup();
    const res = await s.routes.chats(req(`chats?chat=${KEY}&more=cur_1-x`), "PKG");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ rows: [], moreCursor: "abc" });
    expect(reader.listChats).toHaveBeenCalledWith("PKG", CONN, ME, { cursor: "cur_1-x" });
  });

  it("newer messages: a lastModifiedDateTime date range for the open chat (the time is validated and rebuilt), the person's own connection, messages only", async () => {
    reader.listMessages.mockResolvedValue({ messages: [], nextBefore: null });
    const s = setup();
    const res = await s.routes.newer(req(`newer?chat=${KEY}&since=${encodeURIComponent("2026-11-23T14:05:00Z")}`), "PKG");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [], truncated: false });
    expect(reader.listMessages).toHaveBeenCalledWith("PKG", CONN, ME, CHAT, { sinceModified: "2026-11-23T14:05:00.000Z" });
    expect(s.rpc.some((r) => r.fn.includes("activity"))).toBe(false);
  });

  it("a bad chat key, a missing or bad time, a stray parameter, a bad cursor: 400 and no Microsoft call; no feature chat_read: 409", async () => {
    const s = setup();
    for (const q of [`newer?chat=${KEY}`, `newer?since=${encodeURIComponent(T(1))}`, `newer?chat=../x&since=${encodeURIComponent(T(1))}`, `newer?chat=${KEY}&since=yesterday`, `newer?chat=${KEY}&since=${encodeURIComponent(T(1))}&before=${encodeURIComponent(T(0))}`]) {
      expect((await s.routes.newer(req(q), "PKG")).status, q).toBe(400);
    }
    for (const q of ["chats?chat=../x", `chats?chat=${KEY}&more=a b`, `chats?x=1`]) expect((await s.routes.chats(req(q), "PKG")).status, q).toBe(400);
    nothingFromMicrosoft();
    const noFeature = setup({ rows: [row({ has: ["call_links"] })] });
    expect((await noFeature.routes.chats(req("chats"), "PKG")).status).toBe(409);
    expect((await noFeature.routes.newer(req(`newer?chat=${KEY}&since=${encodeURIComponent(T(1))}`), "PKG")).status).toBe(409);
    nothingFromMicrosoft();
  });

  it("only the person's own connection, with the same checks: another person's row, none, cross-site, a hidden module: 404 / 403, and no Microsoft call", async () => {
    for (const rows of [[], [row({ id: OTHER_CONN, mine: false })], [row({ state: "reconnect_required" })]]) {
      const s = setup({ rows });
      expect((await s.routes.chats(req("chats"), "PKG")).status).toBe(404);
      expect((await s.routes.newer(req(`newer?chat=${KEY}&since=${encodeURIComponent(T(1))}`), "PKG")).status).toBe(404);
    }
    expect((await setup().routes.chats(req("chats", "GET", { "sec-fetch-site": "cross-site" }), "PKG")).status).toBe(403);
    expect((await setup({ gateVisible: false }).routes.newer(req(`newer?chat=${KEY}&since=${encodeURIComponent(T(1))}`), "PKG")).status).toBe(404);
    nothingFromMicrosoft();
  });

  it("their own per-person allowance bounds what a runaway client can make Microsoft do: the 13th re-read in a minute is a 429 and reaches nobody", async () => {
    reader.listMessages.mockResolvedValue({ messages: [], nextBefore: null });
    const s = setup({ defaultLimiters: false });
    const q = `newer?chat=${KEY}&since=${encodeURIComponent(T(1))}`;
    let ok = 0;
    for (let i = 0; i < 14; i++) if ((await s.routes.newer(req(q), "PKG")).status === 200) ok += 1;
    expect(ok).toBe(12);
    expect(reader.listMessages).toHaveBeenCalledTimes(12);
  });
});
