// T-230 A: one set of guards per request and session: the session is read and verified once, and the lane, lane list and
// role answers are shared by the layout, page and loaders. Every check still runs; a different cookie is a fresh start.
import { beforeEach, describe, expect, it, vi } from "vitest";

// React's cache() memoises within one server render; outside one it does not. Mirror the render with a per-"request" map
// that a test can clear.
const memo = vi.hoisted(() => ({ maps: [] as Map<string, unknown>[] }));
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  cache: <A extends unknown[], R>(fn: (...a: A) => R) => {
    const m = new Map<string, unknown>();
    memo.maps.push(m);
    return (...a: A): R => {
      const k = JSON.stringify(a);
      if (!m.has(k)) m.set(k, fn(...a));
      return m.get(k) as R;
    };
  },
}));

let cookieList: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => cookieList, set: () => undefined }) }));

const read = vi.fn();
const getLaneClient = vi.fn();
const listLanes = vi.fn();
const rpc = vi.fn();
vi.mock("@nichols/core/lane-router", () => ({
  getLaneClient: (...a: unknown[]) => getLaneClient(...a),
  listLanes: (...a: unknown[]) => listLanes(...a),
}));
vi.mock("@nichols/core/auth", async (orig) => ({
  ...(await orig<typeof import("@nichols/core/auth")>()),
  cookieSessionReader: () => read,
  authActions: () => ({}),
  mfaActions: () => ({}),
}));

const { guards } = await import("@/lib/guards");
const { AuthError } = await import("@nichols/core/auth");

const session = { userId: "u1", accessToken: "tok", aal: "aal2" as const, mfaVerifiedAt: null };

beforeEach(() => {
  memo.maps.forEach((m) => m.clear());
  cookieList = [{ name: "sb-local-auth-token", value: "cookie-a" }, { name: "other", value: "x" }];
  read.mockReset().mockResolvedValue(session);
  getLaneClient.mockReset().mockResolvedValue({ schema: () => ({ rpc }) });
  listLanes.mockReset().mockResolvedValue([{ laneId: "PKG", name: "Pub K Group" }]);
  rpc.mockReset().mockResolvedValue({ data: true, error: null });
});

describe("guards() within one request", () => {
  it("reads and verifies the session once however many guards ask", async () => {
    const g = await guards();
    await Promise.all([g.requireSession(), g.requireLane("PKG"), g.listLanes(), (await guards()).requireRole("PKG", ["owner"])]);
    await (await guards()).requireSession();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("opens the lane and lists the lanes once; repeated role checks for the same lane and roles run the RPC once", async () => {
    const g = await guards();
    await g.requireLane("PKG");
    await g.requireLane("PKG");
    await g.listLanes();
    await g.listLanes();
    await Promise.all([g.requireRole("PKG", ["owner", "admin_technical"]), g.requireRole("PKG", ["admin_technical", "owner"]), g.requireRole("PKG", ["owner", "admin_technical"])]);
    expect(getLaneClient).toHaveBeenCalledTimes(1);
    expect(listLanes).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("does not share a role answer between different roles or different lanes", async () => {
    const g = await guards();
    await g.requireRole("PKG", ["owner"]);
    await g.requireRole("PKG", ["viewer"]);
    await g.requireRole("APK", ["owner"]);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(getLaneClient).toHaveBeenCalledTimes(2); // PKG, APK
  });

  it("a refused role stays refused for the rest of the request, and an empty role list is never allowed", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const g = await guards();
    await expect(g.requireRole("PKG", ["owner"])).rejects.toMatchObject({ reason: "forbidden" });
    await expect(g.requireRole("PKG", ["owner"])).rejects.toMatchObject({ reason: "forbidden" });
    await expect(g.requireRole("PKG", [])).rejects.toBeInstanceOf(AuthError);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("keeps the error semantics: no session, AAL1 and an outage give the same answers to every caller", async () => {
    read.mockResolvedValue(null);
    let g = await guards();
    await expect(g.requireLane("PKG")).rejects.toMatchObject({ reason: "no_session" });
    await expect(g.requireRole("PKG", ["owner"])).rejects.toMatchObject({ reason: "no_session" });
    expect(getLaneClient).not.toHaveBeenCalled();

    memo.maps.forEach((m) => m.clear());
    read.mockResolvedValue({ ...session, aal: "aal1" });
    g = await guards();
    await expect(g.requireLane("PKG")).rejects.toMatchObject({ reason: "mfa_required" });
    await expect(g.requireSession({ allowAal1: true })).resolves.toMatchObject({ aal: "aal1" });

    memo.maps.forEach((m) => m.clear());
    read.mockRejectedValue(new Error("auth service unavailable"));
    g = await guards();
    await expect(g.requireLane("PKG")).rejects.toThrow("auth service unavailable");
    await expect(g.listLanes()).rejects.toThrow("auth service unavailable"); // never read as "no lanes" or access
  });
});

describe("guards() across requests and sessions", () => {
  it("a different auth cookie builds fresh guards and reads the session again (a changed session is never answered from the old one)", async () => {
    const first = await guards();
    await first.requireLane("PKG");
    cookieList = [{ name: "sb-local-auth-token", value: "cookie-b" }];
    read.mockResolvedValue({ ...session, userId: "u2", accessToken: "tok2" });
    const second = await guards();
    await expect(second.requireSession()).resolves.toMatchObject({ userId: "u2" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  it("is keyed only by the auth cookies: other cookies do not matter", async () => {
    const a = await guards();
    cookieList = [...cookieList, { name: "theme", value: "dark" }];
    expect(await guards()).toBe(a);
  });
});
