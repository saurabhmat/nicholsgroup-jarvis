// The Inngest route outside local development (T-037): no keys → 503, never an unsigned dev-mode endpoint.
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = { appEnv: "production", configured: false, devRuntime: true };
vi.mock("../env/server", () => ({
  getServerEnv: () => ({ APP_ENV: env.appEnv, ENABLED_LANES: ["PKG"], NEXT_PUBLIC_APP_URL: "https://portal.example.test" }),
  isDevelopmentRuntime: () => env.devRuntime,
  getInngestEnv: () =>
    env.configured
      ? { configured: true, INNGEST_EVENT_KEY: "test-event-key", INNGEST_SIGNING_KEY: "signkey-test-0123456789abcdef" }
      : { configured: false, missing: ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"] },
}));

beforeEach(() => {
  vi.resetModules();
  env.appEnv = "production";
  env.configured = false;
  env.devRuntime = true;
});

describe("inngestRoute", () => {
  it("answers 503 outside local development when Inngest is not configured", async () => {
    const { inngestRoute, inngestAvailable } = await import("./index");
    expect(inngestAvailable()).toBe(false);
    const route = inngestRoute(() => []);
    for (const method of ["GET", "POST", "PUT"] as const) {
      const res = await route[method](new Request("https://portal.example.test/api/inngest", { method }), {});
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "jobs_not_configured" });
    }
  });

  it("is never available on a PR Preview, even with keys", async () => {
    env.appEnv = "preview";
    env.configured = true;
    const { inngestRoute, inngestAvailable } = await import("./index");
    expect(inngestAvailable()).toBe(false);
    expect((await inngestRoute(() => []).GET(new Request("https://pr.example.test/api/inngest"), {})).status).toBe(503);
  });

  it("refuses an unsigned registration (PUT) in cloud mode, with no outbound call", async () => {
    env.configured = true;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { inngestRoute } = await import("./index");
    const res = await inngestRoute(() => []).PUT(new Request("https://old-deploy.example.test/api/inngest", { method: "PUT" }), {});
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("a production build is never in dev mode, even with APP_ENV=local", async () => {
    env.appEnv = "local";
    env.devRuntime = false;
    env.configured = true;
    const { getInngest } = await import("./index");
    expect(getInngest().mode).not.toBe("dev");
  });

  it("uses dev mode only for APP_ENV=local", async () => {
    const { getInngest } = await import("./index");
    env.configured = true;
    expect(getInngest().mode).not.toBe("dev");
    vi.resetModules();
    env.appEnv = "local";
    const local = await import("./index");
    expect(local.getInngest().mode).toBe("dev");
  });
});
