// /api/webhooks/[provider] (T-036): the route is a thin wrapper over the receiver; with no provider registered yet every
// provider is a 404, nothing is queued, and a GET is refused. Mocks only (rule 10).
import { describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@nichols/core/lane-router", () => ({ getLaneJobClient: vi.fn(async () => { throw new Error("no database in this test"); }) }));
vi.mock("@nichols/core/inngest", () => ({ sendLaneEvent: send, inngestAvailable: () => true }));
vi.mock("@nichols/core/env/server", () => ({ getServerEnv: () => ({ APP_ENV: "local", ENABLED_LANES: ["PKG"] }) }));

const route: Record<string, unknown> = await import("../app/api/webhooks/[provider]/route");
const POST = route.POST as (req: Request, ctx: never) => Promise<Response>;

describe("webhook route", () => {
  it("exports only POST: no route segment config (a build error with cacheComponents) and no GET", () => {
    expect(Object.keys(route).sort()).toEqual(["POST"]);
  });

  it("answers 404 for a provider nobody registered, and queues nothing", async () => {
    for (const provider of ["quickbooks", "stripe", "nope"]) {
      const res = await POST(
        new Request(`http://localhost/api/webhooks/${provider}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
        { params: Promise.resolve({ provider }) } as never,
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(send).not.toHaveBeenCalled();
  });
});
