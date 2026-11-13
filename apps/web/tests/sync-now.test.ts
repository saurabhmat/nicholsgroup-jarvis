// T-238 part B: Sync now. Owner or admin_technical at AAL2 (other roles 403, other lanes 404, no session 401, AAL1 403), cross-site
// refused, one per lane per 2 minutes (database claim), no connection = no claim, audited before any event, ids only. Mocks only.
import { describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { createSyncNowHandler, syncNowEventId } from "../lib/sync-now";

const ORIGIN = "http://localhost:3000";
const USER = "00000000-0000-4000-8000-0000000000aa";
const C1 = "00000000-0000-4000-8000-0000000000b1";
const C2 = "00000000-0000-4000-8000-0000000000b2";
const NOW = new Date("2026-11-13T15:00:30.000Z");
const post = (headers: Record<string, string> = { origin: ORIGIN }) => new Request(`${ORIGIN}/api/lanes/PKG/sync-now`, { method: "POST", headers });

type B = {
  lane?: AuthError | null; role?: AuthError | null; ids?: string[]; listFails?: boolean; claim?: { data?: unknown; error?: { code?: string } | null };
  auditFails?: boolean; sendFails?: (id: string) => boolean;
};
function setup(b: B = {}) {
  const calls = { requireRole: [] as { lane: string; roles: readonly string[] }[], rpc: [] as unknown[][], audit: [] as unknown[], sent: [] as { lane: string; id: string; eventId: string }[], order: [] as string[] };
  const client = { schema: () => ({ rpc: async (...a: unknown[]) => { calls.rpc.push(a); calls.order.push("claim"); return b.claim ?? { data: { ok: true, retry_after_seconds: 0 }, error: null }; } }) };
  const handler = createSyncNowHandler({
    guards: async () => ({
      requireLane: async (lane: string) => {
        if (b.lane) throw b.lane;
        return { session: { userId: USER }, laneId: lane, client } as never;
      },
      requireRole: async (lane: string, roles: readonly string[]) => {
        calls.requireRole.push({ lane, roles });
        if (b.role) throw b.role;
        return { session: { userId: USER }, laneId: lane, client } as never;
      },
    }),
    audit: () => ({ log: vi.fn(async (e: unknown) => { calls.order.push("audit"); if (b.auditFails) throw new Error("audit down"); calls.audit.push(e); }) }) as never,
    listConnections: async () => { if (b.listFails) throw new Error("db text jane@example.test"); return b.ids ?? [C1, C2]; },
    send: async (lane, id, eventId) => { calls.order.push("send"); if (b.sendFails?.(id)) throw new Error("down"); calls.sent.push({ lane, id, eventId }); },
    now: () => NOW,
  });
  return { handler, calls };
}

describe("access", () => {
  it("asks the guard for exactly owner or admin_technical of the requested lane", async () => {
    const { handler, calls } = setup();
    await handler(post(), "PKG");
    expect(calls.requireRole[0]?.lane).toBe("PKG");
    expect([...(calls.requireRole[0]?.roles ?? [])].sort()).toEqual(["admin_technical", "owner"]);
  });
  it("another role gets 403 and nothing is claimed, audited or sent", async () => {
    const { handler, calls } = setup({ role: new AuthError("forbidden") });
    expect((await handler(post(), "PKG")).status).toBe(403);
    expect(calls.rpc).toEqual([]);
    expect(calls.audit).toEqual([]);
    expect(calls.sent).toEqual([]);
  });
  it("AAL1 gets 403 and no session 401", async () => {
    expect((await setup({ lane: new AuthError("mfa_required") }).handler(post(), "PKG")).status).toBe(403);
    expect((await setup({ lane: new AuthError("no_session") }).handler(post(), "PKG")).status).toBe(401);
  });
  it("another lane (not a member, or no such lane, or a malformed one) gets 404 and no role check", async () => {
    const { handler, calls } = setup({ lane: new AuthError("forbidden") });
    for (const lane of ["APK", "XX", "", "pkg", "../x"]) {
      const res = await handler(post(), lane);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(calls.requireRole).toEqual([]);
    expect(calls.sent).toEqual([]);
  });
  it("a cross-site or origin-less request is refused before anything runs", async () => {
    const { handler, calls } = setup();
    for (const h of [{} as Record<string, string>, { origin: "https://evil.example.test" }, { origin: ORIGIN, "sec-fetch-site": "cross-site" }, { origin: ORIGIN, "sec-fetch-site": "same-site" }]) {
      expect((await handler(post(h), "PKG")).status).toBe(403);
    }
    expect(calls.requireRole).toEqual([]);
    expect(calls.sent).toEqual([]);
    expect((await handler(post({ origin: ORIGIN, "sec-fetch-site": "same-origin" }), "PKG")).status).toBe(200);
  });
});

describe("what it does", () => {
  it("claims the limit, audits ids and a count, then sends one manual event per connection with a slot id", async () => {
    const { handler, calls } = setup();
    const res = await handler(post(), "PKG");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "started", connections: 2 });
    expect(calls.order).toEqual(["claim", "audit", "send", "send"]);
    expect(calls.rpc[0]).toEqual(["sync_now_claim", { p_lane: "PKG" }]);
    expect(calls.audit).toEqual([{ laneId: "PKG", actor: { kind: "user", userId: USER }, action: "connection.sync_now", target: "lane:PKG", metadata: { connections: 2 } }]);
    expect(calls.sent).toEqual([
      { lane: "PKG", id: C1, eventId: syncNowEventId(C1, NOW.getTime()) },
      { lane: "PKG", id: C2, eventId: syncNowEventId(C2, NOW.getTime()) },
    ]);
    expect(JSON.stringify(calls.audit)).not.toMatch(/@|token/i);
  });
  it("the event id changes per connection and per 2-minute slot", () => {
    const t = Date.parse("2026-11-13T15:00:00Z");
    expect(syncNowEventId(C1, t)).toBe(syncNowEventId(C1, t + 119_000));
    expect(syncNowEventId(C1, t)).not.toBe(syncNowEventId(C1, t + 120_000));
    expect(syncNowEventId(C1, t)).not.toBe(syncNowEventId(C2, t));
  });
  it("a lane with no usable Google connection says so and does not use up the limit or write an audit row", async () => {
    const { handler, calls } = setup({ ids: [] });
    const res = await handler(post(), "PKG");
    expect(await res.json()).toEqual({ status: "no_connections", connections: 0 });
    expect(calls.rpc).toEqual([]);
    expect(calls.audit).toEqual([]);
  });
  it("sends each connection once even if listed twice", async () => {
    const { handler, calls } = setup({ ids: [C1, C1] });
    await handler(post(), "PKG");
    expect(calls.sent).toHaveLength(1);
  });
});

describe("the rate limit", () => {
  it("a second request inside the window gets 429 with a retry time, and nothing is audited or sent", async () => {
    const { handler, calls } = setup({ claim: { data: { ok: false, retry_after_seconds: 77 }, error: null } });
    const res = await handler(post(), "PKG");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 77 });
    expect(res.headers.get("retry-after")).toBe("77");
    expect(calls.audit).toEqual([]);
    expect(calls.sent).toEqual([]);
  });
  it("a refusal by the database role check is 403; an unreadable limit fails closed (503, nothing sent)", async () => {
    const a = setup({ claim: { data: null, error: { code: "42501" } } });
    expect((await a.handler(post(), "PKG")).status).toBe(403);
    const b = setup({ claim: { data: null, error: { code: "XX000" } } });
    expect((await b.handler(post(), "PKG")).status).toBe(503);
    expect(b.calls.sent).toEqual([]);
    const c = setup({ claim: { data: {}, error: null } });
    expect((await c.handler(post(), "PKG")).status).toBe(429);
  });
});

describe("failures", () => {
  it("an audit failure sends nothing (503)", async () => {
    const { handler, calls } = setup({ auditFails: true });
    expect((await handler(post(), "PKG")).status).toBe(503);
    expect(calls.sent).toEqual([]);
  });
  it("a connection list that cannot be read is 503 with no database text", async () => {
    const res = await setup({ listFails: true }).handler(post(), "PKG");
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("jane");
  });
  it("one event failing still starts the others; all failing is 503", async () => {
    const some = await setup({ sendFails: (id) => id === C1 }).handler(post(), "PKG");
    expect(await some.json()).toEqual({ status: "started", connections: 1 });
    const none = await setup({ sendFails: () => true }).handler(post(), "PKG");
    expect(none.status).toBe(503);
  });
});
