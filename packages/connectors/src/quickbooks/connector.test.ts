// QuickBooks connector behaviour beyond the shared contract (T-050): the CompanyInfo health check, the read-only API
// surface, intuit_tid in the redacted log (QB-9), and the minimal disconnect the contract needs. Mocks only (rule 10).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { HealthStatusSchema } from "../contract/schemas";
import { RateLimiter } from "../http/rate-limit";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { API_SANDBOX, createFakeIntuit, FAKE_REALM, REVOKE_URL } from "../testing/msw/quickbooks/handlers";
import { createQboHarness } from "../testing/quickbooks-harness";

const server = useMockServer();
const LANE = "PKG";

afterEach(() => {
  RateLimiter.resetForTests();
});

async function setup(realms: Record<string, string | null> = {}) {
  const intuit = createFakeIntuit();
  server.use(...intuit.handlers);
  const h = createQboHarness({ intuit, realms });
  const conn = await h.connectViaCallback(LANE);
  return { intuit, h, conn };
}

describe("health reads CompanyInfo", () => {
  it("calls GET /v3/company/{realm}/companyinfo/{realm} with the bearer token and reports ok with the intuit_tid", async () => {
    const { intuit, h, conn } = await setup();
    const health = HealthStatusSchema.parse(await h.connector.health(LANE, conn));
    expect(health).toMatchObject({ ok: true, status: "active", error: null });
    expect(health.provider_tid).toMatch(/^synthetic-tid-\d{4}$/);
    expect(intuit.state.apiRequests).toEqual([
      { realm: FAKE_REALM, authorization: `Bearer ${intuit.state.issued[0]?.access}`, minorversion: "75", method: "GET" },
    ]);
  });

  it("an expired access token is refreshed on the way, then the check passes", async () => {
    const { intuit, h, conn } = await setup();
    h.clock.t += 58 * 60_000;
    expect(await h.connector.health(LANE, conn)).toMatchObject({ ok: true });
    expect(intuit.state.tokenRequests.filter((r) => r.grant === "refresh_token")).toHaveLength(1);
  });

  it("reports reconnect_required (not a throw) when Intuit rejects the refresh token", async () => {
    const { intuit, h, conn } = await setup();
    intuit.state.failRefresh = { status: 400, error: "invalid_grant", always: true };
    h.clock.t += 59 * 60_000;
    const health = HealthStatusSchema.parse(await h.connector.health(LANE, conn));
    expect(health).toMatchObject({ ok: false, status: "reconnect_required" });
    expect(health.error).toMatchObject({ kind: "reconnect_required", disposition: "reconnect_required", provider_error_code: "invalid_grant" });
  });

  it("reports degraded when QuickBooks keeps failing (5xx), with the intuit_tid and no body text", async () => {
    const { intuit, h, conn } = await setup();
    intuit.state.failApi = { status: 503, times: 10 };
    const health = HealthStatusSchema.parse(await h.connector.health(LANE, conn));
    expect(health).toMatchObject({ ok: false, status: "degraded" });
    expect(health.error).toMatchObject({ kind: "transient", http_status: 503 });
    expect(health.provider_tid).toMatch(/^synthetic-tid-/);
    expect(JSON.stringify(health)).not.toContain("synthetic failure");
  });

  it("a response for a different company is never trusted", async () => {
    const { h, conn } = await setup();
    server.use(
      http.get(`${API_SANDBOX}/v3/company/:realm/companyinfo/:id`, () =>
        HttpResponse.json({ CompanyInfo: { Id: "5555555555", CompanyName: "Someone Else" } }, { headers: { intuit_tid: "synthetic-tid-x" } }),
      ),
    );
    const health = await h.connector.health(LANE, conn);
    expect(health).toMatchObject({ ok: false, status: "degraded" });
    expect(health.error?.kind).toBe("provider_error");
  });

  it("a connection that is not usable is reported without calling Intuit", async () => {
    const { intuit, h, conn } = await setup();
    const row = h.rows.get(conn.id);
    if (row) row.status = "reconnect_required";
    const health = await h.connector.health(LANE, conn);
    expect(health).toMatchObject({ ok: false, status: "reconnect_required" });
    expect(intuit.state.apiRequests).toHaveLength(0);
  });
});

describe("read company_info", () => {
  it("returns an allowlisted projection with provenance, and keeps no address or email", async () => {
    const { h, conn } = await setup();
    const res = await h.connector.read<Record<string, unknown>>(LANE, conn, { op: "company_info" });
    expect(res.data).toEqual({
      id: FAKE_REALM,
      company_name: "Synthetic Test Company",
      legal_name: "Synthetic Test Company LLC",
      country: "US",
      fiscal_year_start_month: "January",
      company_start_date: "2020-01-01",
    });
    expect(JSON.stringify(res)).not.toMatch(/synthetic\.person|Synthetic Way|Testville/);
    expect(res).toMatchObject({ lane_id: LANE, provider: "quickbooks", freshness: "live", connection_id: conn.id });
    expect(res.source_refs).toEqual([{ kind: "qbo_company", ref: FAKE_REALM }]);
  });
});

describe("intuit_tid is captured from every response into the redacted log (QB-9)", () => {
  it("logs the tid for successes, a 401, the refresh and a failure; never a token", async () => {
    const { intuit, h, conn } = await setup();
    h.logs.length = 0;
    intuit.state.reject401 = 1;
    await h.connector.health(LANE, conn); // 401 -> refresh -> retry -> ok
    intuit.state.failApi = { status: 400, times: 1 };
    await h.connector.health(LANE, conn); // 400 failure
    const http = h.logs.filter((l) => l.event === "connector.http");
    // company-info 401, token refresh, company-info ok, company-info 400
    expect(http.map((l) => [l.fields.endpoint, l.fields.status])).toEqual([
      ["/v3/company/{realm}/companyinfo/{realm}", 401],
      ["/oauth2/v1/tokens/bearer", 200],
      ["/v3/company/{realm}/companyinfo/{realm}", 200],
      ["/v3/company/{realm}/companyinfo/{realm}", 400],
    ]);
    for (const line of http) expect(String(line.fields.provider_tid)).toMatch(/^synthetic-tid-\d{4}$/);
    expect(http.every((l) => l.provider === "quickbooks" && l.lane_id === LANE)).toBe(true);
    // Intuit's fault code is kept; the realm id is not in the endpoint (template) and no token is anywhere.
    expect(http[0]?.fields.provider_error_code).toBe("003200");
    const text = JSON.stringify(h.logs);
    for (const pair of intuit.state.issued) expect(text).not.toMatch(new RegExp(`${pair.access}|${pair.refresh}`));
    expect(text).not.toContain(FAKE_REALM);
  });
});

describe("the QuickBooks client is read-only", () => {
  it("the API object exposes get and nothing else", async () => {
    const { h } = await setup();
    expect(Object.keys(h.api)).toEqual(["get"]);
  });

  it("api.ts only ever issues GET requests", () => {
    const src = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
    expect([...src.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1])).toEqual(["GET"]);
  });

  it("the connector declares no sync, subscribe or write capability", async () => {
    const { h } = await setup();
    expect(h.connector.capabilities).toEqual({ sync: false, subscribe: false, prepareWrite: false });
    expect("prepareWrite" in h.connector).toBe(false);
    expect("executeWrite" in h.connector).toBe(false);
  });
});

describe("lanes", () => {
  it("the same Intuit app serves each lane with its own realm, tokens and Vault entry", async () => {
    const intuit = createFakeIntuit();
    server.use(...intuit.handlers);
    const h = createQboHarness({ intuit });
    const a = await h.connectViaCallback("PKG");
    const b = await h.connectViaCallback("APK");
    expect(a.id).not.toBe(b.id);
    expect(h.secrets.get(a.id)).not.toBe(h.secrets.get(b.id));
    // A connection cannot be used from the other lane.
    await expect(h.connector.health("APK", a)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
    await expect(h.tokens.accessToken("APK", a)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
  });
});

describe("disconnect (minimal; T-195 owns the full behaviour)", () => {
  it("revokes the refresh token at Intuit's discovered revocation endpoint, deletes the Vault tokens and returns disconnected", async () => {
    const { intuit, h, conn } = await setup();
    const refresh = h.storedSet(conn.id)?.refresh_token;
    const out = await h.connector.disconnect(LANE, conn);
    expect(out.status).toBe("disconnected");
    expect(intuit.state.revokeRequests).toHaveLength(1);
    expect(intuit.state.revokeRequests[0]).toMatchObject({ body: { token: refresh } });
    expect(intuit.state.revokeRequests[0]?.auth).toMatch(/^Basic /);
    expect(h.secrets.has(conn.id)).toBe(false);
  });

  it("is idempotent and does not call Intuit again for a disconnected connection", async () => {
    const { intuit, h, conn } = await setup();
    await h.connector.disconnect(LANE, conn);
    await h.connector.disconnect(LANE, conn);
    expect(intuit.state.revokeRequests).toHaveLength(1);
  });

  it("a token Intuit no longer knows (400) does not keep ours; a transient failure stops before deleting anything", async () => {
    const { h, conn } = await setup();
    server.use(http.post(REVOKE_URL, () => HttpResponse.json({ error: "invalid_token" }, { status: 400 })));
    expect((await h.connector.disconnect(LANE, conn)).status).toBe("disconnected");

    const second = await setup();
    server.use(http.post(REVOKE_URL, () => new HttpResponse(null, { status: 503 })));
    const err = (await second.h.connector.disconnect(LANE, second.conn).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.info.kind).toBe("transient");
    expect(second.h.secrets.has(second.conn.id)).toBe(true);
    expect(second.h.rows.get(second.conn.id)?.status).toBe("active");
  });
});
