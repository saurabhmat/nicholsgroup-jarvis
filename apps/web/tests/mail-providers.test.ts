// T-257: the one read of a company's enabled providers per Settings render. Mocks only.
import { describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { mailProvidersFor } from "../lib/mail-providers";

const guardsOf = (role?: AuthError) => ({ requireRole: vi.fn(async () => { if (role) throw role; return {} as never; }) });

describe("mailProvidersFor", () => {
  it("asks for the own_mail roles and reads once, passing the answer on", async () => {
    const g = guardsOf();
    const read = vi.fn(async () => ({ google: true, microsoft: { cloud: "commercial", tenantIds: ["t"] } }));
    expect(await mailProvidersFor(g, "PKG", read)).toEqual({ state: "known", google: true, microsoft: { cloud: "commercial", tenantIds: ["t"] } });
    expect(read).toHaveBeenCalledTimes(1);
    expect([...(g.requireRole.mock.calls[0] as unknown as [string, string[]])[1]].sort()).toEqual(["admin_technical", "owner", "viewer"]);
  });
  it("a caller who may not connect mail (or not in this lane, or AAL1) gets null and nothing is read", async () => {
    const read = vi.fn();
    for (const reason of ["forbidden", "mfa_required"] as const) expect(await mailProvidersFor(guardsOf(new AuthError(reason)), "PKG", read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it("a failed read is `unknown`, never a guess; an outage in the role check still throws", async () => {
    expect(await mailProvidersFor(guardsOf(), "PKG", async () => { throw new Error("db text"); })).toEqual({ state: "unknown" });
    const g = { requireRole: async () => { throw new Error("outage"); } };
    await expect(mailProvidersFor(g as never, "PKG", vi.fn())).rejects.toThrow("outage");
  });
});
