// The production wiring (T-063): the connect routes know Google as `google`, credentials come from the connector env at
// call time and fail closed naming variables only, importing the wiring needs no environment, the redirect defaults to
// localhost only in local development, and no production file other than the approvals-only write subpath exposes the
// Google writer. Synthetic values.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvValidationError } from "@nichols/core/env/server";

afterEach(() => {
  vi.unstubAllEnvs();
});
const SECRET = "synthetic-wiring-google-secret-7731";

describe("wiring", () => {
  it("registers Google under the google slug next to QuickBooks", async () => {
    const { oauthFlow } = await import("../oauth/index");
    expect(oauthFlow.has("google")).toBe(true);
    expect(oauthFlow.has("qbo")).toBe(true);
    expect(oauthFlow.has("gmail")).toBe(false);
  });

  it("reads the Google env when used, not at import, and fails closed naming variables only", async () => {
    const { googleOAuthProvider } = await import("./index");
    vi.stubEnv("APP_ENV", "local");
    for (const n of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"]) vi.stubEnv(n, "");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", SECRET);
    let error: unknown;
    try {
      googleOAuthProvider.client();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    expect((error as EnvValidationError).missing).toEqual(["GOOGLE_OAUTH_CLIENT_ID"]);
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("local development defaults the redirect to localhost:3000; any other environment requires an https value", async () => {
    const { googleOAuthProvider } = await import("./index");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic-id.apps.example.test");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", SECRET);
    vi.stubEnv("GOOGLE_REDIRECT_URI", "");
    vi.stubEnv("APP_ENV", "local");
    const c = googleOAuthProvider.client();
    expect(c).toMatchObject({ clientId: "synthetic-id.apps.example.test", redirectUri: "http://localhost:3000/api/connect/google/callback", tokenAuth: "post" });
    expect(String(c.clientSecret)).toBe("[redacted]");
    expect(JSON.stringify(c)).not.toContain(SECRET);
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://portal.example.test");
    expect(() => googleOAuthProvider.client()).toThrow(EnvValidationError);
    vi.stubEnv("GOOGLE_REDIRECT_URI", "http://portal.example.test/api/connect/google/callback");
    expect(() => googleOAuthProvider.client()).toThrow(EnvValidationError);
    vi.stubEnv("GOOGLE_REDIRECT_URI", "https://portal.example.test/api/connect/google/callback");
    expect(googleOAuthProvider.client().redirectUri).toBe("https://portal.example.test/api/connect/google/callback");
  });

  it("requests the three read-only scopes and nothing else", async () => {
    const { googleOAuthProvider } = await import("./index");
    expect(googleOAuthProvider.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ]);
    expect(googleOAuthProvider.authorizationParams).toEqual({ access_type: "offline", prompt: "consent", include_granted_scopes: "false" });
  });

  it("exposes the Calendar provider and sync next to the Gmail ones, read-only", async () => {
    const g = await import("./index");
    expect(g.googleCalendarProvider.provider).toBe("google");
    expect(g.googleCalendarProvider.capabilities).toEqual({ watch: "polling", prepareWrite: false });
    expect(typeof g.calSync.run).toBe("function");
    expect(typeof g.calendarIndexStore.applyPage).toBe("function");
  });

  it("only the approvals-only write subpath exposes the Google writer", () => {
    const root = resolve(__dirname, "../../../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", "dist", ".turbo", ".git"].includes(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mts)$/.test(name)) files.push(p);
      }
    };
    walk(join(root, "apps"));
    walk(join(root, "packages"));
    const offenders = files
      .filter((f) => /\bgoogleWriter\b|createGoogleWriter|createGoogleRevoker|revokeGoogleGrant|google\/revoke/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f))
      .filter((f) => !f.startsWith("packages/modules/approvals/") && !f.startsWith("packages/eslint-plugin/src/"))
      .sort();
    expect(offenders).toEqual([
      "packages/connectors/src/google/index.ts",
      "packages/connectors/src/google/revoke.ts",
      "packages/connectors/src/google/token-manager.test.ts",
      "packages/connectors/src/google/wiring.test.ts",
      "packages/connectors/src/google/writer.ts",
      "packages/connectors/src/testing/google-harness.ts",
      "packages/connectors/src/write/index.ts",
    ]);
  });
});
