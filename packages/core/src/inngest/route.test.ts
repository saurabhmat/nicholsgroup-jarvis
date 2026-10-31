// The Inngest route outside local development (T-037): no keys → 503, never an unsigned dev-mode endpoint.
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = { appEnv: "production", configured: false };
vi.mock("../env/server", () => ({
  getServerEnv: () => ({ APP_ENV: env.appEnv }),
  getInngestEnv: () =>
    env.configured
      ? { configured: true, INNGEST_EVENT_KEY: "test-event-key", INNGEST_SIGNING_KEY: "signkey-test-0123456789abcdef" }
      : { configured: false, missing: ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"] },
}));

beforeEach(() => {
  vi.resetModules();
  env.appEnv = "production";
  env.configured = false;
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
