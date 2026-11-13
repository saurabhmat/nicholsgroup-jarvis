// T-243: guards() waits for the request (connection()) before it reads cookies or builds the Supabase auth client. In production the
// layout's first-name lookup called guards() without that wait, and supabase-js read its session (Date.now()) while Next prerendered
// /[laneId] and /[laneId]/settings with the request's cookies (runtime prefetch).
import { beforeEach, describe, expect, it, vi } from "vitest";

const order: string[] = [];
vi.mock("next/server", () => ({ connection: vi.fn(async () => void order.push("connection")) }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => {
    order.push("cookies");
    return { getAll: () => [{ name: "sb-test-auth-token", value: "synthetic" }], set: () => undefined };
  }),
}));
vi.mock("@nichols/core/auth", () => ({
  cookieSessionReader: () => () => {
    order.push("session");
    return Promise.resolve(null);
  },
  createGuards: () => {
    order.push("guards");
    return { requireRole: vi.fn() };
  },
  authActions: vi.fn(),
  mfaActions: vi.fn(),
}));
vi.mock("@nichols/core/lane-router", () => ({ getLaneClient: vi.fn(), listLanes: vi.fn() }));
vi.mock("./timed", () => ({ timed: (_n: string, fn: () => unknown) => fn() }));

beforeEach(() => {
  order.length = 0;
});

describe("guards() and prerendering (T-243)", () => {
  it("waits for the request before reading cookies or building the auth client", async () => {
    const { guards } = await import("./guards");
    await guards();
    expect(order[0]).toBe("connection");
    expect(order.indexOf("connection")).toBeLessThan(order.indexOf("cookies"));
    expect(order.indexOf("connection")).toBeLessThan(order.indexOf("guards"));
  });
  it("a prerender that never gets the request never reaches cookies or the client", async () => {
    const server = await import("next/server");
    vi.mocked(server.connection).mockImplementationOnce(() => new Promise<void>(() => undefined)); // a prerender: connection() never resolves
    const { guards } = await import("./guards");
    void guards();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
  });
});
