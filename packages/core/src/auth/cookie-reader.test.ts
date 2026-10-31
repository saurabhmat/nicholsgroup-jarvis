// cookieSessionReader (T-017 review M1): identity and AAL come from the verified claims of the session's own access
// token, never from the cookie's user object; invalid tokens are "no session"; an auth outage is an error.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Claims = { sub?: unknown; aal?: unknown };
const state: {
  session: { access_token: string; user: { id: string } } | null;
  claims: { data: { claims: Claims } | null; error: { name: string } | null };
  verified: (string | undefined)[];
} = { session: null, claims: { data: null, error: null }, verified: [] };

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      getClaims: async (jwt?: string) => {
        state.verified.push(jwt);
        return state.claims;
      },
    },
  }),
}));
vi.mock("../env/server", () => ({
  getServerEnv: () => ({}),
  requireSupabasePublicEnv: () => ({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" }),
}));

const { cookieSessionReader } = await import("./index");
const read = () => cookieSessionReader({ getAll: () => [] })();
const TOKEN_SUB = "00000000-0000-4000-8000-00000000000a";

beforeEach(() => {
  state.session = { access_token: "the-access-token", user: { id: "00000000-0000-4000-8000-0000000000ff" } };
  state.claims = { data: { claims: { sub: TOKEN_SUB, aal: "aal2" } }, error: null };
  state.verified = [];
});

describe("cookieSessionReader", () => {
  it("verifies the session's own access token and takes the user id from its claims, not the cookie user", async () => {
    expect(await read()).toEqual({ userId: TOKEN_SUB, accessToken: "the-access-token", aal: "aal2" });
    expect(state.verified).toEqual(["the-access-token"]);
  });

  it("reports aal1 unless the verified claims say aal2", async () => {
    for (const aal of ["aal1", undefined, "AAL2", "aal3"]) {
      state.claims = { data: { claims: { sub: TOKEN_SUB, aal } }, error: null };
      expect((await read())?.aal).toBe("aal1");
    }
  });

  it("no session cookie: null, and nothing is verified", async () => {
    state.session = null;
    expect(await read()).toBeNull();
    expect(state.verified).toEqual([]);
  });

  it("an invalid, expired or forged token (verification error) is no session", async () => {
    for (const name of ["AuthInvalidJwtError", "AuthApiError", "AuthSessionMissingError"]) {
      state.claims = { data: null, error: { name } };
      expect(await read()).toBeNull();
    }
  });

  it("claims without a usable subject are no session", async () => {
    for (const sub of [undefined, "", 42]) {
      state.claims = { data: { claims: { sub, aal: "aal2" } }, error: null };
      expect(await read()).toBeNull();
    }
  });

  it("an auth outage throws instead of posing as no session", async () => {
    state.claims = { data: null, error: { name: "AuthRetryableFetchError" } };
    await expect(read()).rejects.toThrow("auth service unavailable");
  });
});
