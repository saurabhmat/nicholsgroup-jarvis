// Sign-in actions and session refresh (T-018) against a mocked @supabase/ssr auth client.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; args: unknown }[] = [];
const results = new Map<string, { data: unknown; error: { name: string } | null }>();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: Object.fromEntries(
      ["signInWithOtp", "verifyOtp", "signOut", "getClaims"].map((m) => [
        m,
        async (args?: unknown) => {
          calls.push({ method: m, args });
          return results.get(m) ?? { data: {}, error: null };
        },
      ]),
    ),
  }),
}));
vi.mock("../env/server", () => ({
  getServerEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://portal.example.test" }),
  requireSupabasePublicEnv: () => ({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" }),
}));

const { authActions, refreshSession, safeNextPath, AuthError } = await import("./index");
const actions = authActions({ getAll: () => [] });

beforeEach(() => {
  calls.length = 0;
  results.clear();
});

describe("sendSignInCode", () => {
  it("never creates users and links back to /auth/confirm", async () => {
    await actions.sendSignInCode("  Owner@Example.test ");
    expect(calls).toEqual([
      {
        method: "signInWithOtp",
        args: { email: "owner@example.test", options: { shouldCreateUser: false, emailRedirectTo: "https://portal.example.test/auth/confirm" } },
      },
    ]);
  });

  it("an unknown address or a rate limit resolves like success (no account discovery)", async () => {
    results.set("signInWithOtp", { data: {}, error: { name: "AuthApiError" } });
    await expect(actions.sendSignInCode("nobody@example.test")).resolves.toBeUndefined();
  });

  it("rejects malformed addresses without calling Supabase; an outage throws", async () => {
    await expect(actions.sendSignInCode("not-an-email")).rejects.toBeInstanceOf(AuthError);
    expect(calls).toEqual([]);
    results.set("signInWithOtp", { data: {}, error: { name: "AuthRetryableFetchError" } });
    await expect(actions.sendSignInCode("owner@example.test")).rejects.toThrow("unavailable");
  });
});

describe("verifySignInCode / verifyEmailLink", () => {
  it("verifies a 6-digit code as an email OTP", async () => {
    results.set("verifyOtp", { data: { session: { access_token: "t" } }, error: null });
    expect(await actions.verifySignInCode("owner@example.test", " 123456 ")).toBe(true);
    expect(calls[0]).toEqual({ method: "verifyOtp", args: { email: "owner@example.test", token: "123456", type: "email" } });
  });

  it("refuses malformed codes and emails before calling Supabase", async () => {
    for (const [e, c] of [["owner@example.test", "12345"], ["owner@example.test", "abcdef"], ["x", "123456"]] as const) {
      expect(await actions.verifySignInCode(e, c)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("a wrong or expired code is false, not an error", async () => {
    results.set("verifyOtp", { data: { session: null }, error: { name: "AuthApiError" } });
    expect(await actions.verifySignInCode("owner@example.test", "000000")).toBe(false);
  });

  it("verifies an email link by token hash and refuses malformed hashes", async () => {
    results.set("verifyOtp", { data: { session: { access_token: "t" } }, error: null });
    expect(await actions.verifyEmailLink("pkce_abcdef0123456789")).toBe(true);
    expect(calls[0]?.args).toEqual({ token_hash: "pkce_abcdef0123456789", type: "email" });
    expect(await actions.verifyEmailLink("bad hash<script>")).toBe(false);
  });

  it("signOut ends only this device's session", async () => {
    await actions.signOut();
    expect(calls).toEqual([{ method: "signOut", args: { scope: "local" } }]);
  });
});

describe("refreshSession", () => {
  it("reports signed-in and the AAL from verified claims", async () => {
    results.set("getClaims", { data: { claims: { sub: "u1", aal: "aal2" } }, error: null });
    expect(await refreshSession({ getAll: () => [] })).toEqual({ signedIn: true, aal: "aal2" });
    results.set("getClaims", { data: { claims: { sub: "u1", aal: "aal1" } }, error: null });
    expect(await refreshSession({ getAll: () => [] })).toEqual({ signedIn: true, aal: "aal1" });
  });

  it("an invalid or missing session is signed out", async () => {
    results.set("getClaims", { data: null, error: { name: "AuthInvalidJwtError" } });
    expect(await refreshSession({ getAll: () => [] })).toEqual({ signedIn: false, aal: null });
  });
});

describe("safeNextPath", () => {
  it("allows same-origin paths only", () => {
    expect(safeNextPath("/finance?lane=PKG")).toBe("/finance?lane=PKG");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", null, "/a b", "/" + "x".repeat(600)]) {
      expect(safeNextPath(bad)).toBe("/");
    }
  });
});
