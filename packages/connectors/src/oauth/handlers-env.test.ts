// T-226: a connect that cannot start because the server is not configured. Logs name the variables and the rule (never values);
// a form submit is sent back to Settings with a fixed code; other callers keep the JSON 503. Synthetic canary values only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvValidationError } from "@nichols/core/env/server";
import { createConnectHandlers } from "./handlers";

const CANARY = "canary-handler-env-6a90e1c4-not-real";

afterEach(() => vi.restoreAllMocks());

function handlers(error: unknown) {
  const flow = { has: (s: string) => s === "google" || s === "mockqbo", start: async () => { throw error; }, callback: async () => ({ ok: true as const }) };
  return createConnectHandlers(flow as never, async () => (async () => ({ userId: "u", client: {} })) as never);
}

const post = (query: string, headers: Record<string, string>) =>
  new Request(`http://localhost:3000/api/connect/google/start${query}`, { method: "POST", headers: { origin: "http://localhost:3000", ...headers } });

const envError = () => new EnvValidationError('connector "google"', ["GOOGLE_OAUTH_CLIENT_ID"], ["GOOGLE_REDIRECT_URI"], { GOOGLE_REDIRECT_URI: "must be on the app's own origin" });

describe("connect start with an unconfigured server", () => {
  it("logs variable names and the rule, never a value, and sends a form post back to Settings with the fixed google code", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // a message that (wrongly) carried a value must still not reach the log: only names and rules are logged
    const e = Object.assign(envError(), { message: `Environment validation failed (${CANARY})` });
    const res = await handlers(e).start(post("?lane=PKG", { "content-type": "application/x-www-form-urlencoded" }), "google");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/PKG/settings?error=google_env");
    const out = log.mock.calls.flat().join(" ");
    expect(out).toContain('(google, connector "google")'); // the fixed scope says which part failed (a core env error is not labelled google)
    expect(out).toContain("GOOGLE_REDIRECT_URI: must be on the app's own origin");
    expect(out).toContain("GOOGLE_OAUTH_CLIENT_ID: is not set");
    expect(out).not.toContain(CANARY);
  });

  it("a script or API caller keeps the JSON 503 with a fixed body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await handlers(envError()).start(post("?lane=PKG", { "content-type": "application/json" }), "google");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("a lane that is not a lane code is never put in the redirect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const lane of ["../x", "pkg", "PKG%0d%0aSet-Cookie:a=b", `${CANARY}`, ""]) {
      const res = await handlers(envError()).start(post(`?lane=${encodeURIComponent(lane)}`, { "content-type": "application/x-www-form-urlencoded" }), "google");
      expect(res.status).toBe(503);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("another provider gets the generic code; a non-env failure is still the plain 503 and logs only the class", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const form = { "content-type": "application/x-www-form-urlencoded" };
    const res = await handlers(envError()).start(post("?lane=PKG", form), "mockqbo");
    expect(res.headers.get("location")).toBe("/PKG/settings?error=connect_env");
    log.mockClear();
    const other = await handlers(new Error(`boom ${CANARY}`)).start(post("?lane=PKG", form), "google");
    expect(other.status).toBe(503);
    expect(log.mock.calls.flat().join(" ")).not.toContain(CANARY);
  });
});
