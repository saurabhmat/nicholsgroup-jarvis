// T-257 (D-55): the local Disconnect route's handler. Mailbox owner only, AAL2, 403 for other roles, 404 for other lanes, cross-site refused,
// fixed answers, and no external request. Mocks only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { createMicrosoftDisconnectHandler } from "../lib/microsoft-disconnect";

afterEach(() => vi.unstubAllGlobals());
const ORIGIN = "http://localhost:3000";
const USER = "00000000-0000-4000-8000-0000000000aa";
const CID = "00000000-0000-4000-8000-0000000000c2";
const post = (headers: Record<string, string> = { origin: ORIGIN }) => new Request(`${ORIGIN}/api/lanes/PKG/connections/${CID}/disconnect`, { method: "POST", headers });
const notFound = () => Object.assign(new Error("Connection not found"), { info: { kind: "not_found" } });

type B = { lane?: AuthError; role?: AuthError; disconnect?: () => Promise<unknown> };
function setup(b: B = {}) {
  const calls = { requireRole: [] as { lane: string; roles: readonly string[] }[], disconnect: [] as unknown[][] };
  const handler = createMicrosoftDisconnectHandler({
    guards: async () => ({
      requireLane: async (lane: string) => {
        if (b.lane) throw b.lane;
        return { session: { userId: USER }, laneId: lane } as never;
      },
      requireRole: async (lane: string, roles: readonly string[]) => {
        calls.requireRole.push({ lane, roles });
        if (b.role) throw b.role;
        return { session: { userId: USER }, laneId: lane, client: {} } as never;
      },
    }),
    disconnect: async (...a) => {
      calls.disconnect.push(a);
      return b.disconnect ? b.disconnect() : true;
    },
  });
  return { handler, calls };
}

describe("access", () => {
  it("asks for the own_mail roles of the requested lane", async () => {
    const { handler, calls } = setup();
    await handler(post(), "PKG", CID);
    expect(calls.requireRole[0]?.lane).toBe("PKG");
    expect([...(calls.requireRole[0]?.roles ?? [])].sort()).toEqual(["admin_technical", "owner", "viewer"]);
  });
  it("another role gets 403 and nothing is disconnected", async () => {
    const { handler, calls } = setup({ role: new AuthError("forbidden") });
    const res = await handler(post(), "PKG", CID);
    expect(res.status).toBe(403);
    expect(calls.disconnect).toEqual([]);
  });
  it("AAL1 gets 403 and no session 401; nothing is disconnected", async () => {
    const a = setup({ lane: new AuthError("mfa_required") });
    expect((await a.handler(post(), "PKG", CID)).status).toBe(403);
    const b = setup({ lane: new AuthError("no_session") });
    expect((await b.handler(post(), "PKG", CID)).status).toBe(401);
    expect([...a.calls.disconnect, ...b.calls.disconnect]).toEqual([]);
  });
  it("another lane (not a member, unknown, malformed) gets 404 and no role check", async () => {
    const { handler, calls } = setup({ lane: new AuthError("forbidden") });
    for (const lane of ["APK", "XX", "", "pkg", "../x"]) {
      const res = await handler(post(), lane, CID);
      expect(res.status, lane).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(calls.requireRole).toEqual([]);
    expect(calls.disconnect).toEqual([]);
  });
  it("a malformed connection id is 404 before any guard", async () => {
    const { handler, calls } = setup();
    expect((await handler(post(), "PKG", "not-a-uuid")).status).toBe(404);
    expect(calls.requireRole).toEqual([]);
  });
  it("a cross-site or origin-less request is refused first", async () => {
    const { handler, calls } = setup();
    for (const h of [{} as Record<string, string>, { origin: "https://evil.example.test" }, { origin: ORIGIN, "sec-fetch-site": "cross-site" }]) expect((await handler(post(h), "PKG", CID)).status).toBe(403);
    expect(calls.requireRole).toEqual([]);
  });
});

describe("what it does", () => {
  it("the owner: disconnects this lane's row as the signed-in user and answers a fixed 200", async () => {
    const { handler, calls } = setup();
    const res = await handler(post(), "PKG", CID.toUpperCase());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "disconnected" });
    expect(calls.disconnect).toEqual([["PKG", CID, USER]]);
  });
  it("someone else's mailbox, another lane's connection or a row of another provider: 404 (the connector says not_found)", async () => {
    const { handler } = setup({ disconnect: async () => { throw notFound(); } });
    const res = await handler(post(), "PKG", CID);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
  it("an outage is a fixed 503 and no text of the error is passed on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { handler } = setup({ disconnect: async () => { throw new Error("db text canary-ms-31"); } });
    const res = await handler(post(), "PKG", CID);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("canary-ms-31");
  });
  it("makes no request to Microsoft or anyone else", async () => {
    const spy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", spy);
    await setup().handler(post(), "PKG", CID);
    expect(spy).not.toHaveBeenCalled();
  });
});
