// T-226: the real Google provider config failing on the start route. Canary values in the environment must appear in neither
// the log nor the redirect; the log names GOOGLE_REDIRECT_URI and the rule.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectHandlers } from "../oauth/handlers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const CANARIES = ["canary-g-client-id-51ac", "canary-g-secret-8e2f", "https://canary-evil-host-77d0.example.test/api/connect/google/callback"];

describe("Google connect start with a redirect on another origin", () => {
  it("logs the variable name and rule only, and redirects a form post to Settings with the fixed code", async () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", CANARIES[0] as string);
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", CANARIES[1] as string);
    vi.stubEnv("GOOGLE_REDIRECT_URI", CANARIES[2] as string);
    const { googleOAuthProvider } = await import("./index");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const flow = {
      has: (s: string) => s === "google",
      start: async () => {
        googleOAuthProvider.client();
        return "https://accounts.example.test/auth";
      },
      callback: async () => ({ ok: true as const }),
    };
    const handlers = createConnectHandlers(flow as never, async () => (async () => ({ userId: "u", client: {} })) as never);
    const res = await handlers.start(
      new Request("http://localhost:3000/api/connect/google/start?lane=PKG", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" } }),
      "google",
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/PKG/settings?error=google_env");
    const out = log.mock.calls.flat().join(" ");
    expect(out).toContain("GOOGLE_REDIRECT_URI: must be on the app's own origin");
    for (const c of CANARIES) {
      expect(out).not.toContain(c);
      expect(res.headers.get("location")).not.toContain(c);
    }
  });
});
