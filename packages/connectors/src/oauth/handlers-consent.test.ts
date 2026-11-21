// T-257: the return from a Microsoft tenant admin consent link lands on the connect callback without a `code`. It is answered with a fixed
// result and touches nothing; a request with a `code` is a connect and takes the normal path. Synthetic values only.
import { describe, expect, it, vi } from "vitest";
import { createConnectHandlers } from "./handlers";

const ORIGIN = "http://localhost:3000";
function setup() {
  const flow = { has: vi.fn(() => true), start: vi.fn(async () => "https://idp.example.test"), callback: vi.fn(async () => ({ ok: false, reason: "invalid_state", provider: "microsoft" })) };
  const authorizer = vi.fn(async () => (async () => ({ userId: "u", client: {} })) as never);
  const handlers = createConnectHandlers(flow as never, authorizer, { onConnected: vi.fn(async () => undefined) });
  const get = (provider: string, query: string) => handlers.callback(new Request(`${ORIGIN}/api/connect/${provider}/callback?${query}`), provider);
  return { flow, authorizer, get };
}

describe("admin consent return", () => {
  it("success: 303 to the lane's Settings with a fixed code; no session, no state, no connect", async () => {
    const { flow, authorizer, get } = setup();
    const res = await get("microsoft", "admin_consent=True&tenant=canary-tenant-77&scope=canary-scope-77&state=PKG.adminconsent");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/PKG/settings?connect=consent_ok&provider=microsoft");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(flow.callback).not.toHaveBeenCalled();
    expect(authorizer).not.toHaveBeenCalled();
  });
  it("an error return: a fixed failure code; the provider's words are not copied anywhere", async () => {
    const { flow, get } = setup();
    const res = await get("microsoft", "error=access_denied&error_description=canary-desc-77&tenant=canary-tenant-77&state=PKG.adminconsent");
    expect(res.headers.get("location")).toBe("/PKG/settings?connect=consent_failed&provider=microsoft");
    expect(JSON.stringify([...res.headers])).not.toMatch(/canary/);
    expect(flow.callback).not.toHaveBeenCalled();
  });
  it("admin_consent together with a code is a connect: the normal path runs, with the session check", async () => {
    const { flow, authorizer, get } = setup();
    const res = await get("microsoft", "admin_consent=True&code=abc&state=PKG.adminconsent");
    expect(flow.callback).toHaveBeenCalledTimes(1);
    expect(authorizer).toHaveBeenCalledTimes(1);
    expect(res.headers.get("location")).toMatch(/connect=invalid_state/);
  });
  it("an empty code is still a connect", async () => {
    const { flow, get } = setup();
    await get("microsoft", "admin_consent=True&code=&state=PKG.adminconsent");
    expect(flow.callback).toHaveBeenCalledTimes(1);
  });
  it("a real connect state without a code (a cancelled or refused sign-in) is a connect return, not a consent return", async () => {
    const { flow, get } = setup();
    await get("microsoft", `error=access_denied&state=PKG.${"A".repeat(43)}`);
    expect(flow.callback).toHaveBeenCalledTimes(1);
  });
  it("another provider's callback never takes this branch", async () => {
    const { flow, get } = setup();
    await get("google", "admin_consent=True&state=PKG.adminconsent");
    expect(flow.callback).toHaveBeenCalledTimes(1);
  });
  it("an unknown provider is still 404", async () => {
    const { flow, get } = setup();
    flow.has.mockReturnValue(false);
    expect((await get("microsoft", "admin_consent=True&state=PKG.adminconsent")).status).toBe(404);
  });
});
