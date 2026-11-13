// T-241: the callback's follow-up (a QuickBooks connect starts its full initial load). Runs only after a successful connect, gets ids
// only, and never changes the redirect: a failure is logged by class.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectHandlers, type OnConnected } from "./handlers";

afterEach(() => vi.restoreAllMocks());
const CONN = "00000000-0000-4000-8000-0000000000c1";

function handlers(result: unknown, onConnected: OnConnected) {
  const flow = { has: () => true, start: async () => "https://idp.example.test", callback: async () => result };
  return createConnectHandlers(flow as never, async () => (async () => ({ userId: "u", client: {} })) as never, { onConnected });
}
const cb = () => new Request("http://localhost:3000/api/connect/qbo/callback?code=c&state=s");

describe("connect callback follow-up (T-241)", () => {
  it("after a successful connect: called once with ids only, then the usual redirect", async () => {
    const seen: unknown[] = [];
    const res = await handlers({ ok: true, provider: "quickbooks", laneId: "PKG", connectionId: CONN }, async (c) => { seen.push(c); }).callback(cb(), "qbo");
    expect(seen).toEqual([{ provider: "quickbooks", laneId: "PKG", connectionId: CONN }]);
    expect(res.headers.get("location")).toBe("/PKG/settings?connect=ok&provider=quickbooks");
  });
  it("a refused connect starts nothing", async () => {
    const seen: unknown[] = [];
    await handlers({ ok: false, reason: "account_refused", provider: "quickbooks", laneId: "PKG" }, async (c) => { seen.push(c); }).callback(cb(), "qbo");
    expect(seen).toEqual([]);
  });
  it("a failing follow-up never breaks the connect: same redirect, logged by class only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await handlers({ ok: true, provider: "quickbooks", laneId: "PKG", connectionId: CONN }, async () => { throw new TypeError("event key canary-7c1 not set"); }).callback(cb(), "qbo");
    expect(res.headers.get("location")).toBe("/PKG/settings?connect=ok&provider=quickbooks");
    const out = log.mock.calls.flat().join(" ");
    expect(out).toContain("TypeError");
    expect(out).not.toContain("canary-7c1");
  });
});
