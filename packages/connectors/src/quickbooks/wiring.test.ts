// The production wiring (T-050): the connect routes know QuickBooks as `qbo`, credentials come from the connector env
// at call time and fail closed naming variables only, and importing the wiring needs no environment. Synthetic values.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvValidationError } from "@nichols/core/env/server";
import { RateLimiter } from "../http/rate-limit";
import { useMockServer } from "../testing/msw/index";
import { AUTHORIZE_URL, createFakeIntuit, FAKE_CLIENT_ID } from "../testing/msw/quickbooks/handlers";

const server = useMockServer();
afterEach(() => {
  vi.unstubAllEnvs();
  RateLimiter.resetForTests();
});

const SECRET = "synthetic-wiring-secret-7731";

describe("wiring", () => {
  it("registers QuickBooks under the qbo slug, and no other provider", async () => {
    const { oauthFlow } = await import("../oauth/index");
    expect(oauthFlow.has("qbo")).toBe(true);
    expect(oauthFlow.has("google")).toBe(true); // T-063
    expect(oauthFlow.has("gmail")).toBe(false);
    expect(oauthFlow.has("quickbooks")).toBe(false);
  });

  it("reads the Intuit env when used, not at import, and fails closed naming variables only", async () => {
    const { quickbooksOAuthProvider } = await import("./index");
    vi.stubEnv("APP_ENV", "local");
    for (const n of ["INTUIT_CLIENT_ID", "INTUIT_CLIENT_SECRET", "INTUIT_REDIRECT_URI", "INTUIT_ENVIRONMENT"]) vi.stubEnv(n, "");
    vi.stubEnv("INTUIT_CLIENT_SECRET", SECRET);
    let error: unknown;
    try {
      quickbooksOAuthProvider.client();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    expect((error as EnvValidationError).missing).toEqual(["INTUIT_CLIENT_ID", "INTUIT_REDIRECT_URI"]);
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("builds the client config from the env and the discovery endpoints for INTUIT_ENVIRONMENT", async () => {
    const { quickbooksOAuthProvider } = await import("./index");
    vi.stubEnv("APP_ENV", "local");
    vi.stubEnv("INTUIT_CLIENT_ID", FAKE_CLIENT_ID);
    vi.stubEnv("INTUIT_CLIENT_SECRET", SECRET);
    vi.stubEnv("INTUIT_REDIRECT_URI", "http://localhost:3000/api/connect/qbo/callback");
    vi.stubEnv("INTUIT_ENVIRONMENT", "sandbox");
    const c = quickbooksOAuthProvider.client();
    expect(c).toMatchObject({ clientId: FAKE_CLIENT_ID, redirectUri: "http://localhost:3000/api/connect/qbo/callback", tokenAuth: "basic" });
    expect(String(c.clientSecret)).toBe("[redacted]");
    expect(JSON.stringify(c)).not.toContain(SECRET);
    server.use(...createFakeIntuit().handlers);
    expect((await quickbooksOAuthProvider.endpoints("PKG")).authorization).toBe(AUTHORIZE_URL);
  });

  it("the requested scope is the accounting scope only", async () => {
    const { quickbooksOAuthProvider } = await import("./index");
    expect(quickbooksOAuthProvider.scopes).toEqual(["com.intuit.quickbooks.accounting"]);
  });
});
