// H-042: the proxy's onboarding access check. Definite refusals are "denied" (the proxy answers 404 before streaming);
// anything uncertain is "unknown" (passed on to the page, which checks again).
import { describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { isOnboardingPath, onboardingVerdict } from "./onboarding-gate";

const OWNER = "00000000-0000-4000-8000-000000000001";

function guards(opts: { role?: Error; lanes?: unknown; rpcError?: unknown; rpcThrows?: boolean }) {
  const rpc = vi.fn(async () => {
    if (opts.rpcThrows) throw new Error("network");
    return { data: opts.lanes ?? null, error: opts.rpcError ?? null };
  });
  const requireRole = vi.fn(async () => {
    if (opts.role) throw opts.role;
    return { client: { schema: () => ({ rpc }) }, session: { userId: OWNER } };
  });
  return { g: { requireRole } as never, requireRole, rpc };
}

describe("isOnboardingPath", () => {
  it.each(["/PKG/onboarding", "/PKG/onboarding/", "/PKG/onboarding/x", "/PKG/onboarding/import", "/PKG/%6Fnboarding/import"])("matches %s", (p) => expect(isOnboardingPath(p)).toBe(true));
  it.each(["/PKG", "/PKG/", "/PKG/settings", "/PKG/onboardingx", "/onboarding", "/PKG/%E0%A4%A"])("does not match %s", (p) => expect(isOnboardingPath(p)).toBe(false));
});

describe("onboardingVerdict", () => {
  it("allowed: owner of the lane and the lane is in allowed_lanes(uid, 'brain')", async () => {
    const { g, requireRole, rpc } = guards({ lanes: ["PKG"] });
    expect(await onboardingVerdict(g, "PKG")).toBe("allowed");
    expect(requireRole).toHaveBeenCalledWith("PKG", ["owner"]);
    expect(rpc).toHaveBeenCalledWith("allowed_lanes", { p_uid: OWNER, p_view: "brain" });
  });

  it("denied: not an owner (viewer, finance operator, admin technical), or not a member of the lane at all", async () => {
    expect(await onboardingVerdict(guards({ role: new AuthError("forbidden") }).g, "PKG")).toBe("denied");
  });

  it("denied: an owner whose brain view does not include this lane", async () => {
    expect(await onboardingVerdict(guards({ lanes: ["APK"] }).g, "PKG")).toBe("denied");
    expect(await onboardingVerdict(guards({ lanes: [] }).g, "PKG")).toBe("denied");
  });

  it("unknown: session problems, outages and unreadable answers (the page decides)", async () => {
    expect(await onboardingVerdict(guards({ role: new AuthError("no_session") }).g, "PKG")).toBe("unknown");
    expect(await onboardingVerdict(guards({ role: new AuthError("mfa_required") }).g, "PKG")).toBe("unknown");
    expect(await onboardingVerdict(guards({ role: new Error("db down") }).g, "PKG")).toBe("unknown");
    expect(await onboardingVerdict(guards({ rpcError: { code: "XX000" } }).g, "PKG")).toBe("unknown");
    expect(await onboardingVerdict(guards({ lanes: "PKG" }).g, "PKG")).toBe("unknown");
    expect(await onboardingVerdict(guards({ rpcThrows: true }).g, "PKG")).toBe("unknown");
  });
});
