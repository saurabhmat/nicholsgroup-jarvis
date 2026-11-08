// T-219: the Composio routes' logic without Next.js. Origin check, authorization errors, not configured, and the coarse
// redirect (no provider text, no account id, no address in the URL).
import { AuthError } from "@nichols/core/auth";
import { describe, expect, it, vi } from "vitest";
import { ConnectorError } from "../contract/errors";
import { createComposioHandlers } from "./handlers";

const ORIGIN = "https://app.example.test";
const authorize = async () => ({ userId: "u", client: {} as never });
function make(over: Partial<Parameters<typeof createComposioHandlers>[0]> = {}) {
  const flow = { start: vi.fn(async () => "https://connect.composio.dev/link/x"), callback: vi.fn(async () => ({ ok: true as const, laneId: "PKG", toolkit: "gmail" as const, connectionId: "c" })) };
  const check = vi.fn(async () => ({ status: "ok" as const, checked_at: "2026-11-08T12:00:00.000Z" }));
  return { flow, check, h: createComposioHandlers({ flow, authorizer: async () => authorize, check, ...over }) };
}
const post = (path: string, origin: string | null = ORIGIN) => new Request(`${ORIGIN}${path}`, { method: "POST", headers: origin ? { origin } : {} });

describe("start", () => {
  it("303 to the consent page, no-store", async () => {
    const { h, flow } = make();
    const res = await h.start(post("/api/connect/composio/start?lane=PKG&toolkit=gmail"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://connect.composio.dev/link/x");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(flow.start).toHaveBeenCalledWith("gmail", "PKG", expect.any(Function));
  });
  it("refuses a cross-origin or origin-less POST before anything runs", async () => {
    const { h, flow } = make();
    expect((await h.start(post("/api/connect/composio/start?lane=PKG&toolkit=gmail", "https://evil.example.test"))).status).toBe(403);
    expect((await h.start(post("/api/connect/composio/start?lane=PKG&toolkit=gmail", null))).status).toBe(403);
    expect(flow.start).not.toHaveBeenCalled();
  });
  it("404 for an unknown toolkit (the flow is not reached)", async () => {
    const { h, flow } = make();
    expect((await h.start(post("/api/connect/composio/start?lane=PKG&toolkit=notion"))).status).toBe(404);
    expect(flow.start).not.toHaveBeenCalled();
  });
  it("409 not_configured when the auth config id is missing", async () => {
    const { h, flow } = make();
    flow.start.mockRejectedValueOnce(new ConnectorError({ kind: "connection_unavailable", message: "This toolkit is not configured" }));
    const res = await h.start(post("/api/connect/composio/start?lane=PKG&toolkit=gmail"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_configured" });
  });
  it("maps authorization errors (401/403) and outages (503 without provider text)", async () => {
    const { h, flow } = make();
    flow.start.mockRejectedValueOnce(new AuthError("forbidden"));
    expect([401, 403]).toContain((await h.start(post("/api/connect/composio/start?lane=PKG&toolkit=gmail"))).status);
    flow.start.mockRejectedValueOnce(new Error("secret provider text"));
    const res = await h.start(post("/api/connect/composio/start?lane=PKG&toolkit=gmail"));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});

describe("callback", () => {
  it("redirects to the lane's Settings with a coarse code and the toolkit only", async () => {
    const { h } = make();
    const res = await h.callback(new Request(`${ORIGIN}/api/connect/composio/callback?state=PKG.x&connected_account_id=ca_1`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/PKG/settings?connect=ok&provider=composio&toolkit=gmail");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("a refusal after the account was active adds the remove-access notice; never any message text", async () => {
    const { h, flow } = make();
    flow.callback.mockResolvedValueOnce({ ok: false, reason: "account_refused", laneId: "PKG", toolkit: "gmail", message: "long text with boss@example.test" } as never);
    const res = await h.callback(new Request(`${ORIGIN}/api/connect/composio/callback?state=PKG.x`));
    const loc = res.headers.get("location") ?? "";
    expect(loc).toBe("/PKG/settings?connect=account_refused&provider=composio&toolkit=gmail&notice=remove_app_access");
    expect(loc).not.toContain("example.test");
  });
  it("garbage state goes to the entry page with invalid_state", async () => {
    const { h, flow } = make();
    flow.callback.mockResolvedValueOnce({ ok: false, reason: "invalid_state" } as never);
    const res = await h.callback(new Request(`${ORIGIN}/api/connect/composio/callback?state=zz`));
    expect(res.headers.get("location")).toBe("/?connect=invalid_state&provider=composio");
  });
});

describe("test", () => {
  it("runs the check for the lane and toolkit and returns only status and time", async () => {
    const { h, check } = make();
    const res = await h.test(post("/api/connect/composio/test?lane=PKG&toolkit=googlecalendar"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", checked_at: "2026-11-08T12:00:00.000Z" });
    expect(check).toHaveBeenCalledWith("PKG", "googlecalendar");
  });
  it("is refused cross-origin, for unknown toolkits, and when authorize fails (the check never runs)", async () => {
    const { h, check } = make({ authorizer: async () => async () => { throw new AuthError("forbidden"); } });
    expect((await h.test(post("/api/connect/composio/test?lane=PKG&toolkit=gmail", "https://evil.example.test"))).status).toBe(403);
    expect((await h.test(post("/api/connect/composio/test?lane=PKG&toolkit=drive"))).status).toBe(404);
    expect([401, 403]).toContain((await h.test(post("/api/connect/composio/test?lane=PKG&toolkit=gmail"))).status);
    expect(check).not.toHaveBeenCalled();
  });
});
