// POST /api/webhooks/microsoft (T-068, T-264): the route is a thin wrapper over the Microsoft receiver. The validation handshake is answered as text/plain (nothing else is done), a
// request that is not from a subscription changes nothing, and nothing is queued. The database is not reachable in this test (any lookup would fail), which also proves the handshake
// reads nothing. Mocks only (rule 10).
import { describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@nichols/core/lane-router", () => ({ getLaneJobClient: vi.fn(async () => { throw new Error("no database in this test"); }) }));
vi.mock("@nichols/core/inngest", () => ({ sendLaneEvent: send, inngestAvailable: () => true }));
vi.mock("@nichols/core/env/server", () => ({
  getServerEnv: () => ({ APP_ENV: "local", ENABLED_LANES: ["PKG"] }),
  requireConnectorEnv: () => {
    throw new Error("not configured");
  },
}));

const route: Record<string, unknown> = await import("../app/api/webhooks/microsoft/route");
const POST = route.POST as (req: Request) => Promise<Response>;

describe("microsoft webhook route", () => {
  it("exports only POST: no route segment config (a build error with cacheComponents) and no GET", () => {
    expect(Object.keys(route).sort()).toEqual(["POST"]);
  });

  it("answers the validation handshake: 200, text/plain, the decoded token, nosniff; no database read, nothing queued", async () => {
    const res = await POST(new Request("http://localhost/api/webhooks/microsoft?validationToken=Validation%3A%20abc%3D%3D", { method: "POST", headers: { "content-type": "text/plain" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("Validation: abc==");
    expect(send).not.toHaveBeenCalled();
  });

  it("a notification for a subscription nobody recorded: the lookup cannot run here (no database), so it is a 503 (Graph retries) and nothing is queued", async () => {
    const res = await POST(new Request("http://localhost/api/webhooks/microsoft", { method: "POST", body: JSON.stringify({ value: [{ subscriptionId: "sub-x", clientState: "x".repeat(40) }] }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  it("garbage is a 400 and a wrong content type a 415, both before any lookup", async () => {
    expect((await POST(new Request("http://localhost/api/webhooks/microsoft", { method: "POST", body: "nope", headers: { "content-type": "application/json" } }))).status).toBe(400);
    expect((await POST(new Request("http://localhost/api/webhooks/microsoft", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } }))).status).toBe(415);
  });
});
