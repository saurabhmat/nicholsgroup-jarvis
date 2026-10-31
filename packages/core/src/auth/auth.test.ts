import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { LaneAccessError, type LaneClient } from "../lane-router/index";
import { AuthError, authErrorResponse, createGuards, totpVerifiedAt, type VerifiedSession } from "./index";

const SESSION: VerifiedSession = { userId: "00000000-0000-4000-8000-000000000001", accessToken: "tok", aal: "aal2", mfaVerifiedAt: 1_000_000 };

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

describe("requireStepUp (T-020)", () => {
  const at = (seconds: number) => () => seconds * 1000;
  const guards = (session: VerifiedSession | null, nowSeconds: number) => createGuards(async () => session, { getLaneClient: vi.fn() }, at(nowSeconds));

  it("passes when the last TOTP code is within the window", async () => {
    expect(await guards(SESSION, 1_000_000 + 299).requireStepUp(300)).toBe(SESSION);
  });

  it("403 step_up_required when the code is older than the window, missing, or from the future", async () => {
    expect(await reason(guards(SESSION, 1_000_000 + 301).requireStepUp(300))).toBe("403 step_up_required");
    expect(await reason(guards({ ...SESSION, mfaVerifiedAt: null }, 1_000_000).requireStepUp(300))).toBe("403 step_up_required");
    expect(await reason(guards(SESSION, 1_000_000 - 120).requireStepUp(300))).toBe("403 step_up_required");
  });

  it("still requires a session at AAL2 first", async () => {
    expect(await reason(guards(null, 1_000_000).requireStepUp(300))).toBe("401 no_session");
    expect(await reason(guards({ ...SESSION, aal: "aal1" }, 1_000_000).requireStepUp(300))).toBe("403 mfa_required");
  });

  it("refuses nonsense windows", async () => {
    for (const w of [0, 10, 3601, 1.5, Number.NaN]) expect(await reason(guards(SESSION, 1_000_000).requireStepUp(w))).toBe("403 forbidden");
  });
});

describe("totpVerifiedAt", () => {
  it("takes the latest TOTP timestamp from the detailed amr form", () => {
    expect(totpVerifiedAt([{ method: "otp", timestamp: 5 }, { method: "totp", timestamp: 10 }, { method: "mfa/totp", timestamp: 20 }])).toBe(20);
  });

  it("is null for the string form, other methods, bad timestamps and non-arrays", () => {
    expect(totpVerifiedAt(["totp", "otp"])).toBeNull();
    expect(totpVerifiedAt([{ method: "otp", timestamp: 5 }])).toBeNull();
    expect(totpVerifiedAt([{ method: "totp", timestamp: "10" }, { method: "totp", timestamp: Number.POSITIVE_INFINITY }])).toBeNull();
    expect(totpVerifiedAt(undefined)).toBeNull();
    expect(totpVerifiedAt({ method: "totp", timestamp: 1 })).toBeNull();
  });
});
