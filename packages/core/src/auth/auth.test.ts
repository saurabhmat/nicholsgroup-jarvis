import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { LaneAccessError, type LaneClient } from "../lane-router/index";
import { AuthError, authErrorResponse, createGuards, type VerifiedSession } from "./index";

const SESSION: VerifiedSession = { userId: "00000000-0000-4000-8000-000000000001", accessToken: "tok", aal: "aal2" };

function laneClient(roleResult: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => roleResult);
  const client = { schema: vi.fn(() => ({ rpc })) } as unknown as LaneClient;
  return { client, rpc };
}

const reason = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof AuthError ? `${String(e.status)} ${e.reason}` : String(e)));

describe("auth module", () => {
  it("imports server-only first", () => {
    expect(readFileSync(new URL("./index.ts", import.meta.url), "utf8").split("\n")[0]).toBe('import "server-only";');
  });
});

describe("requireSession", () => {
  it("returns a verified AAL2 session", async () => {
    expect(await createGuards(async () => SESSION).requireSession()).toBe(SESSION);
  });

  it("401 without a valid session; reader failures (outage, config) propagate instead of posing as no session", async () => {
    expect(await reason(createGuards(async () => null).requireSession())).toBe("401 no_session");
    expect(await reason(createGuards(async () => Promise.reject(new Error("auth service unavailable"))).requireSession())).toBe("Error: auth service unavailable");
  });

  it("403 mfa_required at AAL1 unless the page allows it", async () => {
    const guards = createGuards(async () => ({ ...SESSION, aal: "aal1" }));
    expect(await reason(guards.requireSession())).toBe("403 mfa_required");
    expect((await guards.requireSession({ allowAal1: true })).aal).toBe("aal1");
  });
});

describe("requireLane", () => {
  it("returns the lane client from the router for the session", async () => {
    const { client } = laneClient({ data: true, error: null });
    const getLaneClient = vi.fn(async () => client);
    const ctx = await createGuards(async () => SESSION, { getLaneClient }).requireLane("PKG");
    expect(ctx).toEqual({ session: SESSION, laneId: "PKG", client });
    expect(getLaneClient).toHaveBeenCalledWith("PKG", SESSION);
  });

  it("403 forbidden when the router refuses the lane", async () => {
    const getLaneClient = vi.fn(async () => {
      throw new LaneAccessError("not_allowed");
    });
    expect(await reason(createGuards(async () => SESSION, { getLaneClient }).requireLane("PKG"))).toBe("403 forbidden");
  });

  it("never asks the router at AAL1 or without a session", async () => {
    const getLaneClient = vi.fn();
    await reason(createGuards(async () => ({ ...SESSION, aal: "aal1" }), { getLaneClient }).requireLane("PKG"));
    await reason(createGuards(async () => null, { getLaneClient }).requireLane("PKG"));
    expect(getLaneClient).not.toHaveBeenCalled();
  });

  it("other router errors propagate (not masked as 403)", async () => {
    const getLaneClient = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await reason(createGuards(async () => SESSION, { getLaneClient }).requireLane("PKG"))).toBe("Error: network down");
  });
});

describe("requireRole", () => {
  it("checks core.has_lane_role for the session user and lane", async () => {
    const { client, rpc } = laneClient({ data: true, error: null });
    const guards = createGuards(async () => SESSION, { getLaneClient: async () => client });
    await guards.requireRole("PKG", ["owner", "finance_operator"]);
    expect(rpc).toHaveBeenCalledWith("has_lane_role", { p_uid: SESSION.userId, p_lane: "PKG", p_roles: ["owner", "finance_operator"] });
  });

  it("403 when the role check is false, errors, or no role is given", async () => {
    for (const result of [{ data: false, error: null }, { data: null, error: { message: "x" } }, { data: "true", error: null }]) {
      const { client } = laneClient(result);
      expect(await reason(createGuards(async () => SESSION, { getLaneClient: async () => client }).requireRole("PKG", ["owner"]))).toBe("403 forbidden");
    }
    const { client, rpc } = laneClient({ data: true, error: null });
    expect(await reason(createGuards(async () => SESSION, { getLaneClient: async () => client }).requireRole("PKG", []))).toBe("403 forbidden");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("authErrorResponse", () => {
  it("maps AuthError to a no-store JSON response and ignores other errors", async () => {
    const res = authErrorResponse(new AuthError("forbidden"));
    expect(res?.status).toBe(403);
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(await res?.json()).toEqual({ error: "forbidden" });
    expect(authErrorResponse(new Error("x"))).toBeNull();
  });
});
