// The temporary connection test (T-198): status mapping, the reduced result, and no write. Mocks only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { API_SANDBOX, createFakeIntuit, FAKE_REALM } from "../testing/msw/quickbooks/handlers";
import { createQboHarness } from "../testing/quickbooks-harness";
import { createConnectionCheck, MAX_INTUIT_TID_LENGTH } from "./connection-check";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

function setup() {
  const intuit = createFakeIntuit();
  server.use(...intuit.handlers);
  const h = createQboHarness({ intuit });
  const check = createConnectionCheck({
    find: async (laneId) => {
      const row = [...h.rows.values()].find((r) => r.lane_id === laneId && r.provider === "quickbooks" && r.status !== "disconnected");
      return row ? h.connections.load(laneId, row.id) : null;
    },
    connector: h.connector,
    now: () => h.clock.t,
  });
  return { intuit, h, check };
}

describe("connection check", () => {
  it("not_connected when the lane has no QuickBooks connection, and no request to Intuit", async () => {
    const { intuit, check } = setup();
    expect(await check("PKG")).toEqual({ status: "not_connected", checked_at: expect.any(String), intuit_tid: null });
    expect(intuit.state.apiRequests).toHaveLength(0);
  });

  it("ok with the intuit_tid after a connect, and the result has exactly three fields (no realm, token or company data)", async () => {
    const { intuit, h, check } = setup();
    await h.connectViaCallback("PKG");
    intuit.state.apiRequests.length = 0;
    const res = await check("PKG");
    expect(res.status).toBe("ok");
    expect(res.intuit_tid).toMatch(/^synthetic-tid-\d{4}$/);
    expect(Object.keys(res).sort()).toEqual(["checked_at", "intuit_tid", "status"]);
    const text = JSON.stringify(res);
    expect(text).not.toContain(FAKE_REALM);
    expect(text).not.toMatch(/Synthetic Test Company|synthetic-access|synthetic-refresh/);
    // Read-only: one GET, no other request (no refresh, no revoke, no write).
    expect(intuit.state.apiRequests.map((r) => r.method)).toEqual(["GET"]);
    expect(intuit.state.revokeRequests).toHaveLength(0);
    expect(intuit.state.tokenRequests.filter((t) => t.grant !== "authorization_code")).toHaveLength(0);
  });

  it("clamps an over-long intuit_tid to the 256 characters the Settings client accepts", async () => {
    const { h } = setup();
    const conn = await h.connectViaCallback("PKG");
    const long = "t".repeat(1000);
    const check = createConnectionCheck({
      find: async () => conn,
      connector: { health: async () => ({ ok: true, status: "ok", checked_at: "2026-11-04T10:00:00.000Z", provider_tid: long }) as never },
      now: () => h.clock.t,
    });
    const res = await check("PKG");
    expect(res.status).toBe("ok");
    expect(res.intuit_tid).toHaveLength(MAX_INTUIT_TID_LENGTH);
    expect(res.intuit_tid).toBe(long.slice(0, 256));
  });

  it("reconnect_required when Intuit rejects the refresh token", async () => {
    const { intuit, h, check } = setup();
    await h.connectViaCallback("PKG");
    intuit.state.failRefresh = { status: 400, error: "invalid_grant", always: true };
    h.clock.t += 59 * 60_000;
    expect((await check("PKG")).status).toBe("reconnect_required");
  });

  it("reconnect_required when the connection row says so, without calling Intuit", async () => {
    const { intuit, h, check } = setup();
    const conn = await h.connectViaCallback("PKG");
    intuit.state.apiRequests.length = 0;
    const row = h.rows.get(conn.id);
    if (row) row.status = "reconnect_required";
    expect((await check("PKG")).status).toBe("reconnect_required");
    expect(intuit.state.apiRequests).toHaveLength(0);
  });

  it("error when QuickBooks keeps failing, and when the connection lookup fails; no body text leaks", async () => {
    const { h, check } = setup();
    await h.connectViaCallback("PKG");
    server.use(http.get(`${API_SANDBOX}/v3/company/:realm/companyinfo/:id`, () => HttpResponse.json({ Fault: { Error: [{ Message: "synthetic failure text" }] } }, { status: 503 })));
    const res = await check("PKG");
    expect(res.status).toBe("error");
    expect(JSON.stringify(res)).not.toContain("synthetic failure text");
    const broken = createConnectionCheck({ find: async () => Promise.reject(new Error("database password=synthetic")), connector: h.connector });
    const res2 = await broken("PKG");
    expect(res2.status).toBe("error");
    expect(JSON.stringify(res2)).not.toContain("password");
  });

  it("a pending connection (the connect never finished) is not_connected", async () => {
    const { h, check } = setup();
    await h.connections.ensureConnection("PKG", "quickbooks", FAKE_REALM);
    expect((await check("PKG")).status).toBe("not_connected");
  });

  it("the lane's check never sees another lane's connection", async () => {
    const { h, check } = setup();
    await h.connectViaCallback("PKG");
    expect((await check("APK")).status).toBe("not_connected");
  });
});
