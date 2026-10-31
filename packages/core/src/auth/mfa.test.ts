// TOTP MFA actions (T-019) against a mocked @supabase/ssr auth client.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Factor = { id: string; factor_type: string; status: string };
const state = {
  factors: [] as Factor[],
  aal: "aal1" as string | null,
  verifyError: null as { name: string } | null,
  calls: [] as { method: string; args?: unknown }[],
};

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.aal, nextLevel: "aal2" }, error: null }),
        listFactors: async () => ({
          data: { all: state.factors, totp: state.factors.filter((f) => f.factor_type === "totp" && f.status === "verified") },
          error: null,
        }),
        unenroll: async (args: unknown) => {
          state.calls.push({ method: "unenroll", args });
          return { data: {}, error: null };
        },
        enroll: async (args: unknown) => {
          state.calls.push({ method: "enroll", args });
          return { data: { id: "11111111-1111-4111-8111-111111111111", totp: { qr_code: "<svg/>", secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://x" } }, error: null };
        },
        challengeAndVerify: async (args: unknown) => {
          state.calls.push({ method: "challengeAndVerify", args });
          return { data: {}, error: state.verifyError };
        },
      },
    },
  }),
}));
vi.mock("../env/server", () => ({
  getServerEnv: () => ({}),
  requireSupabasePublicEnv: () => ({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" }),
}));

const { mfaActions } = await import("./index");
const mfa = mfaActions({ getAll: () => [] });
const VERIFIED = { id: "22222222-2222-4222-8222-222222222222", factor_type: "totp", status: "verified" };
const STALE = { id: "33333333-3333-4333-8333-333333333333", factor_type: "totp", status: "unverified" };

beforeEach(() => {
  state.factors = [];
  state.aal = "aal1";
  state.verifyError = null;
  state.calls = [];
});

describe("status", () => {
  it("reports the AAL and the verified factor", async () => {
    expect(await mfa.status()).toEqual({ aal: "aal1", verifiedFactorId: null });
    state.factors = [VERIFIED, STALE];
    state.aal = "aal2";
    expect(await mfa.status()).toEqual({ aal: "aal2", verifiedFactorId: VERIFIED.id });
  });
});

describe("beginTotpEnrollment", () => {
  it("removes unfinished enrolments, then enrols a TOTP factor", async () => {
    state.factors = [STALE];
    const e = await mfa.beginTotpEnrollment();
    expect(e).toEqual({ factorId: "11111111-1111-4111-8111-111111111111", qrDataUri: "data:image/svg+xml;utf-8,%3Csvg%2F%3E", secret: "JBSWY3DPEHPK3PXP" });
    expect(state.calls.map((c) => c.method)).toEqual(["unenroll", "enroll"]);
    expect(state.calls[0]?.args).toEqual({ factorId: STALE.id });
  });

  it("refuses when a verified factor exists (challenge instead; no second authenticator by this path)", async () => {
    state.factors = [VERIFIED];
    await expect(mfa.beginTotpEnrollment()).rejects.toThrow("already enrolled");
    expect(state.calls).toEqual([]);
  });
});

describe("qrDataUri", () => {
  it("accepts raw SVG and Supabase's data URI, and refuses anything else", async () => {
    const { qrDataUri } = await import("./mfa");
    expect(qrDataUri("data:image/svg+xml;utf-8,<svg></svg>")).toBe("data:image/svg+xml;utf-8,<svg></svg>");
    expect(qrDataUri("<svg/>")).toBe("data:image/svg+xml;utf-8,%3Csvg%2F%3E");
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "https://example.test/qr.svg"]) expect(() => qrDataUri(bad)).toThrow();
  });
});

describe("verifyTotp", () => {
  it("verifies a 6-digit code for the user's own factor", async () => {
    state.factors = [VERIFIED];
    expect(await mfa.verifyTotp(VERIFIED.id, " 123456 ")).toBe(true);
    expect(state.calls).toEqual([{ method: "challengeAndVerify", args: { factorId: VERIFIED.id, code: "123456" } }]);
  });

  it("refuses malformed input, foreign factors and wrong codes", async () => {
    state.factors = [VERIFIED];
    expect(await mfa.verifyTotp("not-a-uuid", "123456")).toBe(false);
    expect(await mfa.verifyTotp(VERIFIED.id, "12345")).toBe(false);
    expect(await mfa.verifyTotp("44444444-4444-4444-8444-444444444444", "123456")).toBe(false);
    expect(state.calls).toEqual([]);
    state.verifyError = { name: "AuthApiError" };
    expect(await mfa.verifyTotp(VERIFIED.id, "000000")).toBe(false);
  });

  it("an outage throws", async () => {
    state.factors = [VERIFIED];
    state.verifyError = { name: "AuthRetryableFetchError" };
    await expect(mfa.verifyTotp(VERIFIED.id, "123456")).rejects.toThrow("unavailable");
  });
});
