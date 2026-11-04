// QuickBooks connect flow (QB-5, QB-6 CSRF, QB-7, T-050) on the T-035 framework, against the fake Intuit: endpoints from
// discovery, a server-side `state` bound to lane and user (mismatch and replay refused), the lane's realm enforced,
// and tokens entering the Vault only from the callback. Mocks only (rule 10).
import { AuthError } from "@nichols/core/auth";
import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNT_IN_USE_MESSAGE, ConnectorError } from "../contract/errors";
import { createConnectHandlers } from "../oauth/handlers";
import { CONNECT_ROLES } from "../oauth/flow";
import { RateLimiter } from "../http/rate-limit";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { createQboHarness } from "../testing/quickbooks-harness";
import { API_SANDBOX, AUTHORIZE_URL, createFakeIntuit, FAKE_CLIENT_ID, FAKE_CODE, FAKE_REALM } from "../testing/msw/quickbooks/handlers";
import { SecretValue } from "../vault/secret";
import { createQuickBooksOAuthProvider } from "./provider";

const server = useMockServer();
function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a value");
  return v;
}
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const REDIRECT = "http://localhost:3000/api/connect/qbo/callback";

afterEach(() => {
  RateLimiter.resetForTests();
});

function setup(realms: Record<string, string | null> = {}, intuitOptions: Parameters<typeof createFakeIntuit>[0] = {}) {
  const intuit = createFakeIntuit(intuitOptions);
  server.use(...intuit.handlers);
  const h = createQboHarness({ intuit, realms });
  return { intuit, h };
}

const query = (url: string, extra: Record<string, string> = { code: FAKE_CODE, realmId: FAKE_REALM }) =>
  new URLSearchParams({ state: new URL(url).searchParams.get("state") ?? "", ...extra });

describe("start", () => {
  it("sends the user to Intuit's authorization endpoint from the discovery document with the accounting scope only", async () => {
    const { intuit, h } = setup();
    const url = new URL(await h.flow.start("qbo", "PKG", h.as(ADMIN)));
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: FAKE_CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: "com.intuit.quickbooks.accounting",
    });
    expect(url.searchParams.get("scope")).not.toMatch(/openid|payment|payroll/i);
    expect(url.searchParams.get("state")).toMatch(/^PKG\.[A-Za-z0-9_-]{43}$/);
    expect(intuit.state.discoveryRequests).toBe(1);
    // Only the hash of the state is stored server-side.
    expect([...h.states.keys()]).toEqual([h.stateHash(url.searchParams.get("state") as string)]);
    expect(h.audits.map((a) => a.action)).toEqual(["connection.connect_started"]);
  });

  it("uses the production discovery document for INTUIT_ENVIRONMENT=production", async () => {
    const intuit = createFakeIntuit({ environment: "production" });
    server.use(...intuit.handlers);
    const seen: string[] = [];
    server.events.on("request:start", ({ request }) => seen.push(new URL(request.url).pathname));
    const h = createQboHarness({ intuit, environment: "production" });
    await h.flow.start("qbo", "PKG", h.as(ADMIN));
    expect(seen).toEqual(["/.well-known/openid_configuration"]);
  });

  it("caches discovery across connects", async () => {
    const { intuit, h } = setup();
    await h.flow.start("qbo", "PKG", h.as(ADMIN));
    await h.flow.start("qbo", "PKG", h.as(ADMIN));
    expect(intuit.state.discoveryRequests).toBe(1);
  });

  it("refuses a redirect URI that is not this app's QuickBooks callback", async () => {
    const intuit = createFakeIntuit();
    server.use(...intuit.handlers);
    const h = createQboHarness({ intuit });
    const make = (redirectUri: string) =>
      createQuickBooksOAuthProvider({
        environment: () => "sandbox",
        client: () => ({ clientId: FAKE_CLIENT_ID, clientSecret: new SecretValue("synthetic-intuit-client-secret-01"), redirectUri }),
        discovery: h.discovery,
        laneConfig: h.laneConfig,
      });
    expect(make(REDIRECT).client().redirectUri).toBe(REDIRECT);
    expect(make("https://staging.example.test/api/connect/qbo/callback").client().redirectUri).toMatch(/\/api\/connect\/qbo\/callback$/);
    for (const bad of ["http://localhost:3000/api/connect/google/callback", "http://localhost:3000/", "not a url"]) {
      expect(() => make(bad).client(), bad).toThrow(ConnectorError);
    }
  });
});

describe("callback", () => {
  it("exchanges the code with Basic client auth and PKCE, stores the token set only now, and audits the connect", async () => {
    const { intuit, h } = setup({ PKG: FAKE_REALM });
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    expect(h.secrets.size).toBe(0); // nothing in the Vault after start
    const result = await h.flow.callback("qbo", query(url), h.as(ADMIN));
    expect(result).toMatchObject({ ok: true, provider: "quickbooks", laneId: "PKG" });
    const req = need(intuit.state.tokenRequests[0]);
    expect(req.grant).toBe("authorization_code");
    expect(req.auth).toMatch(/^Basic /);
    expect(req.form.get("redirect_uri")).toBe(REDIRECT);
    expect(req.form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.secrets.size).toBe(1);
    const row = need([...h.rows.values()][0]);
    expect(row).toMatchObject({ lane_id: "PKG", provider: "quickbooks", external_account_id: FAKE_REALM, status: "active" });
    // The refresh token's expiry (101 days from now) is recorded on the connection.
    expect(Date.parse(row.token_expires_at ?? "")).toBeGreaterThan(Date.now() + 100 * 86400_000);
    expect(h.audits.map((a) => a.action)).toEqual(["connection.connect_started", "connection.connect.requested", "connection.connect.succeeded"]);
    expect(JSON.stringify(h.audits)).not.toContain(intuit.state.issued[0]?.refresh);
  });

  it("records intuit_tid from the token response in the redacted log", async () => {
    const { h } = setup();
    await h.connectViaCallback("PKG");
    const lines = h.logs.filter((l) => l.event === "connector.http" && (l.fields.endpoint as string) === "/oauth2/v1/tokens/bearer");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => /^synthetic-tid-\d{4}$/.test(String(l.fields.provider_tid)))).toBe(true);
  });
});

describe("state (CSRF, QB-6)", () => {
  it("rejects a callback whose state is not one we issued", async () => {
    const { intuit, h } = setup();
    await h.flow.start("qbo", "PKG", h.as(ADMIN));
    const forged = `PKG.${"A".repeat(43)}`;
    const r = await h.flow.callback("qbo", new URLSearchParams({ state: forged, code: FAKE_CODE, realmId: FAKE_REALM }), h.as(ADMIN));
    expect(r).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(intuit.state.tokenRequests).toHaveLength(0);
    expect(h.secrets.size).toBe(0);
  });

  it("rejects a missing or malformed state", async () => {
    const { intuit, h } = setup();
    for (const state of [undefined, "", "PKG", "not-a-state", "pkg.xxxx", `../${"A".repeat(43)}`]) {
      const q = new URLSearchParams({ code: FAKE_CODE, realmId: FAKE_REALM });
      if (state !== undefined) q.set("state", state);
      expect(await h.flow.callback("qbo", q, h.as(ADMIN))).toMatchObject({ ok: false, reason: "invalid_state" });
    }
    expect(intuit.state.tokenRequests).toHaveLength(0);
  });

  it("rejects the state when another user presents it (bound to the user who started)", async () => {
    const { intuit, h } = setup();
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    expect(await h.flow.callback("qbo", query(url), h.as(OTHER))).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(intuit.state.tokenRequests).toHaveLength(0);
    expect(h.secrets.size).toBe(0);
  });

  it("rejects the state in another lane (bound to the lane): the lane in the state is what is authorised and looked up", async () => {
    const { intuit, h } = setup();
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    const state = new URL(url).searchParams.get("state") as string;
    const swapped = state.replace(/^PKG\./, "APK.");
    expect(await h.flow.callback("qbo", new URLSearchParams({ state: swapped, code: FAKE_CODE, realmId: FAKE_REALM }), h.as(ADMIN))).toMatchObject({
      ok: false,
      reason: "invalid_state",
      laneId: "APK",
    });
    expect(intuit.state.tokenRequests).toHaveLength(0);
  });

  it("rejects a replayed callback: the state works once", async () => {
    const { intuit, h } = setup();
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    expect(await h.flow.callback("qbo", query(url), h.as(ADMIN))).toMatchObject({ ok: true });
    expect(await h.flow.callback("qbo", query(url), h.as(ADMIN))).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(intuit.state.tokenRequests).toHaveLength(1);
  });

  it("rejects an expired state (10 minutes)", async () => {
    const { intuit, h } = setup();
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    h.clock.t += 11 * 60_000;
    expect(await h.flow.callback("qbo", query(url), h.as(ADMIN))).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(intuit.state.tokenRequests).toHaveLength(0);
  });

  it("a user who cancels at Intuit's consent screen gets 'denied' and no token request", async () => {
    const { intuit, h } = setup();
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    const r = await h.flow.callback("qbo", new URLSearchParams({ state: new URL(url).searchParams.get("state") ?? "", error: "access_denied" }), h.as(ADMIN));
    expect(r).toMatchObject({ ok: false, reason: "denied" });
    expect(intuit.state.tokenRequests).toHaveLength(0);
  });
});

describe("realm (spec finance 8.1)", () => {
  it("accepts the lane's configured realm", async () => {
    const { h } = setup({ PKG: FAKE_REALM });
    const conn = await h.connectViaCallback("PKG");
    expect(conn.external_account_id).toBe(FAKE_REALM);
  });

  it("rejects a callback for a different realm than lane_config's, before any token is requested, and stores nothing", async () => {
    const { intuit, h } = setup({ PKG: "1111111111111111" });
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    const r = await h.flow.callback("qbo", query(url), h.as(ADMIN));
    expect(r).toMatchObject({ ok: false, reason: "account_refused", laneId: "PKG" });
    expect(intuit.state.tokenRequests).toHaveLength(0);
    expect(h.secrets.size).toBe(0);
    expect(h.rows.size).toBe(0);
    expect(h.audits.map((a) => a.action)).toContain("connection.connect.failed");
  });

  it("accepts any realm when the lane has none configured (first connect)", async () => {
    const { h } = setup({ PKG: null });
    expect((await h.connectViaCallback("PKG")).external_account_id).toBe(FAKE_REALM);
  });

  it("each lane uses its own configured realm", async () => {
    const { h } = setup({ PKG: FAKE_REALM, APK: "2222222222222222" });
    await expect(h.connectViaCallback("APK")).rejects.toThrow("account_refused");
    expect((await h.connectViaCallback("PKG")).lane_id).toBe("PKG");
  });

  it.each([
    ["no realmId", {}],
    ["empty realmId", { realmId: "" }],
    ["non-numeric realmId", { realmId: "../../x" }],
    ["too long", { realmId: "1".repeat(21) }],
  ])("rejects a callback with %s", async (_n, extra) => {
    const { intuit, h } = setup();
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    const r = await h.flow.callback("qbo", query(url, { code: FAKE_CODE, ...extra }), h.as(ADMIN));
    expect(r).toMatchObject({ ok: false, reason: "account_refused" });
    expect(intuit.state.tokenRequests).toHaveLength(0);
  });

  it("rejects a callback that names two realms", async () => {
    const { intuit, h } = setup();
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    const q = query(url);
    q.append("realmId", "9999999999");
    expect(await h.flow.callback("qbo", q, h.as(ADMIN))).toMatchObject({ ok: false, reason: "account_refused" });
    expect(intuit.state.tokenRequests).toHaveLength(0);
  });

  it("an outage reading lane_config is an outage, not a refusal of the account, and no token is requested", async () => {
    const { intuit, h } = setup();
    h.laneConfig.qboRealmId = async () => {
      throw new ConnectorError({ kind: "transient", message: "Lane configuration unavailable" });
    };
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    expect(await h.flow.callback("qbo", query(url), h.as(ADMIN))).toMatchObject({ ok: false, reason: "unavailable" });
    expect(intuit.state.tokenRequests).toHaveLength(0);
  });
});

describe("who may connect (owner or admin_technical of the lane, at aal2)", () => {
  it("the connect roles are exactly owner and admin_technical", () => {
    expect([...CONNECT_ROLES]).toEqual(["owner", "admin_technical"]);
  });

  it("the routes answer 401 / 403 from the session guard and start nothing", async () => {
    const { h } = setup();
    const call = async (e: AuthError | null) => {
      const handlers = createConnectHandlers(h.flow, async () => async () => {
        if (e) throw e;
        return { userId: ADMIN, client: { uid: ADMIN } as never };
      });
      return handlers.start(new Request("http://localhost:3000/api/connect/qbo/start?lane=PKG", { method: "POST", headers: { origin: "http://localhost:3000" } }), "qbo");
    };
    expect((await call(new AuthError("no_session"))).status).toBe(401);
    expect((await call(new AuthError("mfa_required"))).status).toBe(403);
    expect((await call(new AuthError("forbidden"))).status).toBe(403);
    expect(h.states.size).toBe(0);
    expect(h.audits).toHaveLength(0);
    const ok = await call(null);
    expect(ok.status).toBe(303);
    expect(h.states.size).toBe(1);
  });

  it("the callback route re-checks the session and a guard failure there exchanges nothing", async () => {
    const { intuit, h } = setup();
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    const handlers = createConnectHandlers(h.flow, async () => async () => {
      throw new AuthError("forbidden");
    });
    const res = await handlers.callback(new Request(`http://localhost:3000/api/connect/qbo/callback?${query(url)}`), "qbo");
    expect(res.status).toBe(403);
    expect(intuit.state.tokenRequests).toHaveLength(0);
  });

  it("the callback route redirects with a coarse code only (no provider text, no tokens)", async () => {
    const { h } = setup({ PKG: "1111111111111111" });
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    const handlers = createConnectHandlers(h.flow, async () => h.as(ADMIN));
    const res = await handlers.callback(new Request(`http://localhost:3000/api/connect/qbo/callback?${query(url)}`), "qbo");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?connect=account_refused&provider=quickbooks");
  });
});

describe("the realm in the redirect URL must be the realm of the token (security M1, L6, D-24)", () => {
  const OTHER_REALM = "1234567890123456";

  it("an edited realmId (token is for company A, URL says B) is refused: nothing stored, no revoke request, the tokens are dropped", async () => {
    // Intuit issues a token for the fake's company (FAKE_REALM); the user edits the callback to name another company.
    const { intuit, h } = setup({ PKG: null });
    // The lane is already connected to the other company with working tokens.
    const existing = await h.connectViaCallback("PKG", ADMIN, FAKE_REALM);
    const storedBefore = h.secrets.get(existing.id);
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    const r = await h.flow.callback("qbo", query(url, { code: FAKE_CODE, realmId: OTHER_REALM }), h.as(ADMIN));
    expect(r).toMatchObject({ ok: false, reason: "account_refused", laneId: "PKG", message: expect.stringContaining("remove its access") });
    // The code was exchanged (a grant exists) and CompanyInfo for the edited realm failed with the new token.
    expect(intuit.state.tokenRequests.filter((t) => t.grant === "authorization_code")).toHaveLength(2);
    // Nothing stored, no new connection, the existing tokens are untouched.
    expect(h.secrets.get(existing.id)).toBe(storedBefore);
    expect(h.rows.size).toBe(1);
    expect(h.stats.stores).toBe(1);
    // D-24: no revoke request is sent (it would be an external write); the refusal is audited.
    expect(intuit.state.revokeRequests).toHaveLength(0);
    expect(h.audits.map((a) => a.action)).toContain("connection.connect.failed");
    expect(h.audits.map((a) => a.action)).toContain("connection.connect.grant_not_stored");
    // The tokens never reach the log or the audit trail.
    const text = JSON.stringify([h.logs, h.audits]);
    for (const pair of intuit.state.issued) expect(text).not.toMatch(new RegExp(`${pair.access}|${pair.refresh}`));
  });

  it("a CompanyInfo answer for a different company than the realm is refused the same way", async () => {
    const { intuit, h } = setup();
    server.use(
      http.get(`${API_SANDBOX}/v3/company/:realm/companyinfo/:id`, () => HttpResponse.json({ CompanyInfo: { Id: "5555555555" } }, { headers: { intuit_tid: "synthetic-tid-x" } })),
    );
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    expect(await h.flow.callback("qbo", query(url), h.as(ADMIN))).toMatchObject({ ok: false, reason: "account_refused" });
    expect(h.secrets.size).toBe(0);
    expect(h.rows.size).toBe(0);
    expect(intuit.state.revokeRequests).toHaveLength(0);
  });

  it("an outage while checking CompanyInfo is 'unavailable', not a refusal, and still stores nothing and revokes nothing", async () => {
    const { intuit, h } = setup();
    intuit.state.failApi = { status: 503, times: 10 };
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    const r = await h.flow.callback("qbo", query(url), h.as(ADMIN));
    expect(r).toMatchObject({ ok: false, reason: "unavailable", message: expect.stringContaining("remove its access") });
    expect(h.secrets.size).toBe(0);
    expect(intuit.state.revokeRequests).toHaveLength(0);
  });

  it("the callback route adds a notice so the owner is told to remove the app's access in Intuit", async () => {
    const { h } = setup();
    server.use(http.get(`${API_SANDBOX}/v3/company/:realm/companyinfo/:id`, () => HttpResponse.json({ CompanyInfo: { Id: "5555555555" } })));
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    const handlers = createConnectHandlers(h.flow, async () => h.as(ADMIN));
    const res = await handlers.callback(new Request(`http://localhost:3000/api/connect/qbo/callback?${query(url)}`), "qbo");
    expect(res.headers.get("location")).toBe("/?connect=account_refused&provider=quickbooks&notice=remove_app_access");
  });

  it("a refusal before the exchange (wrong configured realm) has no grant and no notice", async () => {
    const { h } = setup({ PKG: "1111111111111111" });
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    const r = await h.flow.callback("qbo", query(url), h.as(ADMIN));
    expect(r).toMatchObject({ ok: false, reason: "account_refused" });
    expect(r).not.toHaveProperty("message");
  });
});

describe("one provider account per lane (D-23)", () => {
  const OTHER_REALM = "2222222222222222";

  it("the same QuickBooks company cannot be connected in a second lane: refused with a clear message, nothing stored, no revoke", async () => {
    const { intuit, h } = setup();
    const first = await h.connectViaCallback("PKG");
    const url = await h.flow.start("qbo", "APK", h.as(ADMIN));
    const r = await h.flow.callback("qbo", query(url), h.as(ADMIN));
    expect(r).toMatchObject({
      ok: false,
      reason: "account_refused",
      laneId: "APK",
      message: expect.stringContaining("This QuickBooks company is already connected to another company in Jarvis."),
    });
    // The first lane keeps its connection; the second lane has no row and no tokens.
    expect([...h.rows.values()].map((r) => [r.lane_id, r.status])).toEqual([["PKG", "active"]]);
    expect(h.secrets.size).toBe(1);
    expect(h.secrets.has(first.id)).toBe(true);
    expect(intuit.state.revokeRequests).toHaveLength(0);
    expect(h.audits.map((a) => a.action)).toContain("connection.connect.grant_not_stored");
    // The message never names the other lane.
    expect(JSON.stringify(r)).not.toContain("PKG");
  });

  it("the callback route reports it as a refused account", async () => {
    const { h } = setup();
    await h.connectViaCallback("PKG");
    const url = await h.flow.start("qbo", "APK", h.as(ADMIN));
    const handlers = createConnectHandlers(h.flow, async () => h.as(ADMIN));
    const res = await handlers.callback(new Request(`http://localhost:3000/api/connect/qbo/callback?${query(url)}`), "qbo");
    expect(res.headers.get("location")).toBe("/?connect=account_refused&provider=quickbooks&notice=remove_app_access");
  });

  it("a disconnected connection does not hold the account: another lane can connect it", async () => {
    const { h } = setup();
    const first = await h.connectViaCallback("PKG");
    await h.disconnectForTest("PKG", first);
    expect((await h.connectViaCallback("APK")).lane_id).toBe("APK");
  });

  it("a different company in the second lane is fine", async () => {
    const intuit = createFakeIntuit({ extraRealms: [OTHER_REALM] });
    server.use(...intuit.handlers);
    const h = createQboHarness({ intuit });
    await h.connectViaCallback("PKG");
    expect((await h.connectViaCallback("APK", ADMIN, OTHER_REALM)).external_account_id).toBe(OTHER_REALM);
  });

  it("reconnecting in the same lane is still allowed", async () => {
    const { h } = setup();
    const a = await h.connectViaCallback("PKG");
    const b = await h.connectViaCallback("PKG");
    expect(b.id).toBe(a.id);
  });

  it("an account refused when the token is stored (it was taken after the row was made) is refused the same way", async () => {
    const { h } = setup();
    h.vault.storeToken = async () => {
      throw new ConnectorError({ kind: "forbidden", message: ACCOUNT_IN_USE_MESSAGE });
    };
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    expect(await h.flow.callback("qbo", query(url), h.as(ADMIN))).toMatchObject({ ok: false, reason: "account_refused" });
  });
});

describe("production: a lane without a configured realm cannot connect (security L1)", () => {
  it("fails closed before any token is requested", async () => {
    const intuit = createFakeIntuit();
    server.use(...intuit.handlers);
    const h = createQboHarness({ intuit, requireConfiguredRealm: true });
    const url = await h.flow.start("qbo", "PKG", h.as(ADMIN));
    expect(await h.flow.callback("qbo", query(url), h.as(ADMIN))).toMatchObject({ ok: false, reason: "account_refused" });
    expect(intuit.state.tokenRequests).toHaveLength(0);
    expect(h.secrets.size).toBe(0);
  });

  it("connects when the realm is configured", async () => {
    const intuit = createFakeIntuit();
    server.use(...intuit.handlers);
    const h = createQboHarness({ intuit, requireConfiguredRealm: true, realms: { PKG: FAKE_REALM } });
    expect((await h.connectViaCallback("PKG")).external_account_id).toBe(FAKE_REALM);
  });

  it("local and preview keep the first-connect behaviour (no realm configured is allowed)", async () => {
    const intuit = createFakeIntuit();
    server.use(...intuit.handlers);
    const h = createQboHarness({ intuit, requireConfiguredRealm: false });
    expect((await h.connectViaCallback("PKG")).external_account_id).toBe(FAKE_REALM);
  });

  it("the wiring requires a configured realm exactly when APP_ENV is production", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/requireConfiguredRealm:\s*\(\)\s*=>\s*getServerEnv\(\)\.APP_ENV === "production"/);
  });
});

describe("tokens enter the Vault only from the callback (QB-7, security M2)", () => {
  it("the connector's connect refuses every input (Vault reference, authorization code, Playground or offline token) with no request and no write", async () => {
    const { intuit, h } = setup();
    const inputs = [
      { kind: "vault_secret" as const, secret_ref: "00000000-0000-4000-8000-0000000000f1", external_account_id: FAKE_REALM },
      { kind: "oauth_code" as const, code: FAKE_CODE, redirect_uri: REDIRECT, external_account_id: FAKE_REALM, code_verifier: "v".repeat(43) },
      { kind: "oauth_code" as const, code: FAKE_CODE, redirect_uri: REDIRECT },
    ];
    for (const input of inputs) {
      await expect(h.connector.connect("PKG", input)).rejects.toMatchObject({ info: { kind: "invalid_input", message: expect.stringContaining("in-app") } });
    }
    expect(intuit.state.tokenRequests).toHaveLength(0);
    expect(h.secrets.size).toBe(0);
    expect(h.rows.size).toBe(0);
    expect(h.stats.stores).toBe(0);
  });

  it("nothing else in the package stores a token for QuickBooks: only the wiring of the callback path calls storeToken", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL(".", import.meta.url);
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => /\bstoreToken\b/.test(readFileSync(new URL(f, dir), "utf8")))
      .sort();
    // index.ts (wiring) only; connector.ts has no way to store a token.
    expect(offenders).toEqual(["index.ts"]);
  });
});
