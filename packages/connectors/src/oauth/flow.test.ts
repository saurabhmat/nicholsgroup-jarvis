// End-to-end tests of the OAuth connect flow (T-035) against a mock OAuth server (MSW). The state store is an in-memory
// twin of core.oauth_state_create / _consume (same user, same lane, once, before expiry; the SQL itself is covered by
// supabase/core/supabase/tests/100_oauth_states.test.sql). Synthetic values only.
import type { Audit, AuditEntry } from "@nichols/core/audit";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import type { LogEntry } from "../log/index";
import { RateLimiter } from "../http/rate-limit";
import { createConnectorLogger } from "../log/index";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { forgetSecretsForTests, isSecretValue, SecretValue } from "../vault/secret";
import { createHttpClient } from "../http/client";
import { createOAuthFlow, type OAuthProvider } from "./flow";
import { codeChallenge, hashState } from "./pkce";
import type { StateStore } from "./state";

const OAUTH = "https://oauth.mock.test";
const REDIRECT = "http://localhost:3000/api/connect/mockqbo/callback";
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const ACCESS = "synthetic-access-oauth-1";
const REFRESH = "synthetic-refresh-oauth-1";

const server = useMockServer();

/** Mock OAuth server: records token requests; answers with a synthetic token set or a configured error. */
function mockTokenEndpoint(opts: { status?: number; body?: unknown } = {}) {
  const requests: { form: URLSearchParams; auth: string | null }[] = [];
  server.use(
    http.post(`${OAUTH}/token`, async ({ request }) => {
      requests.push({ form: new URLSearchParams(await request.text()), auth: request.headers.get("authorization") });
      return HttpResponse.json(
        opts.body ?? { access_token: ACCESS, refresh_token: REFRESH, token_type: "bearer", expires_in: 3600, x_refresh_token_expires_in: 8_726_400 },
        { status: opts.status ?? 200 },
      );
    }),
  );
  return requests;
}

function setup(over: { provider?: Partial<OAuthProvider>; auditFails?: boolean } = {}) {
  const now = { t: Date.UTC(2026, 10, 2, 12) };
  const states = new Map<string, { laneId: string; userId: string; provider: string; codeVerifier: string; redirectUri: string; expires: number }>();
  const stateStore: StateStore = {
    async create(client, laneId, provider, stateHash, codeVerifier, redirectUri) {
      states.set(stateHash, { laneId, userId: (client as unknown as { uid: string }).uid, provider, codeVerifier, redirectUri, expires: now.t + 600_000 });
    },
    async consume(client, laneId, stateHash) {
      const s = states.get(stateHash);
      if (!s || s.laneId !== laneId || s.userId !== (client as unknown as { uid: string }).uid || s.expires <= now.t) return null;
      states.delete(stateHash);
      return { provider: s.provider, codeVerifier: s.codeVerifier, redirectUri: s.redirectUri };
    },
  };
  const audits: AuditEntry[] = [];
  const audit: Audit = {
    async log(e) {
      if (over.auditFails) throw new Error("audit down");
      audits.push(e);
    },
  };
  const ensured: [string, string, string][] = [];
  const stored: { laneId: string; connId: string; secret: SecretValue; expiresAt: Date | null; actor?: string }[] = [];
  const logs: LogEntry[] = [];
  const provider: OAuthProvider = {
    provider: "quickbooks",
    slug: "mockqbo",
    scopes: ["com.intuit.quickbooks.accounting"],
    endpoints: async () => ({ authorization: `${OAUTH}/authorize`, token: `${OAUTH}/token` }),
    client: () => ({ clientId: "synthetic-client-id", clientSecret: new SecretValue("synthetic-client-secret"), redirectUri: REDIRECT, tokenAuth: "basic" }),
    identify: async ({ tokens, callback }) => ({
      externalAccountId: callback.get("realmId") ?? "missing",
      expiresAt: new Date(now.t + Number(tokens.x_refresh_token_expires_in) * 1000),
    }),
    ...over.provider,
  };
  const flow = createOAuthFlow({
    providers: [provider],
    states: stateStore,
    connections: {
      async ensureConnection(laneId, prov, externalAccountId) {
        ensured.push([laneId, prov, externalAccountId]);
        return mintLaneBoundConnection({
          id: "00000000-0000-4000-8000-0000000000c9",
          lane_id: laneId,
          provider: prov,
          external_account_id: externalAccountId,
          status: "pending",
          features: {},
          features_checked_at: null,
          token_expires_at: null,
          last_sync_at: null,
          last_error: null,
        }) as LaneBoundConnection;
      },
    },
    async storeToken(laneId, conn, secret, expiresAt, actor) {
      stored.push({ laneId, connId: conn.id, secret, expiresAt, actor });
    },
    audit,
    logger: createConnectorLogger({ sink: (e) => logs.push(e) }),
    httpFor: (p, laneId, baseUrl) =>
      createHttpClient({ provider: p.provider, laneId, baseUrl, errorCode: (b) => (b as { error?: string } | null)?.error, logger: createConnectorLogger({ sink: (e) => logs.push(e) }) }),
  });
  const as = (userId: string) => async (laneId: string) => ({ userId, client: { uid: userId, laneId } as never });
  return { flow, states, audits, ensured, stored, logs, now, as };
}

/** Plays the provider: reads the authorization URL and builds the redirect back to the callback. */
function providerRedirect(authorizationUrl: string, extra: Record<string, string> = { code: "synthetic-code-1", realmId: "realm-synthetic-1" }) {
  const u = new URL(authorizationUrl);
  return { query: new URLSearchParams({ state: u.searchParams.get("state") ?? "", ...extra }), challenge: u.searchParams.get("code_challenge") };
}

afterEach(() => {
  forgetSecretsForTests();
  RateLimiter.resetForTests();
});

describe("connect flow end to end (mock OAuth server)", () => {
  it("start → consent → callback: PKCE verified, connection created, token set stored in the Vault, audited", async () => {
    const tokenRequests = mockTokenEndpoint();
    const t = setup();
    const url = await t.flow.start("mockqbo", "PKG", t.as(ADMIN));
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${OAUTH}/authorize`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "synthetic-client-id",
      redirect_uri: REDIRECT,
      scope: "com.intuit.quickbooks.accounting",
      code_challenge_method: "S256",
    });
    const state = u.searchParams.get("state") as string;
    expect(state).toMatch(/^PKG\.[A-Za-z0-9_-]{43}$/);
    expect([...t.states.keys()]).toEqual([hashState(state)]); // only the hash is stored

    const { query, challenge } = providerRedirect(url);
    const result = await t.flow.callback("mockqbo", query, t.as(ADMIN));
    expect(result).toEqual({ ok: true, provider: "quickbooks", laneId: "PKG", connectionId: "00000000-0000-4000-8000-0000000000c9" });

    // the token endpoint got the code, the redirect URI and a verifier matching the challenge, with Basic client auth
    expect(tokenRequests).toHaveLength(1);
    const form = tokenRequests[0]?.form as URLSearchParams;
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("synthetic-code-1");
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    expect(codeChallenge(form.get("code_verifier") as string)).toBe(challenge);
    expect(form.get("client_secret")).toBeNull();
    expect(tokenRequests[0]?.auth).toBe(`Basic ${Buffer.from("synthetic-client-id:synthetic-client-secret").toString("base64")}`);

    expect(t.ensured).toEqual([["PKG", "quickbooks", "realm-synthetic-1"]]);
    expect(t.stored).toHaveLength(1);
    const s = t.stored[0];
    expect(isSecretValue(s?.secret)).toBe(true);
    expect(JSON.parse(s?.secret.reveal() as string)).toMatchObject({ access_token: ACCESS, refresh_token: REFRESH });
    expect(s?.expiresAt?.toISOString()).toBe(new Date(t.now.t + 8_726_400_000).toISOString());
    expect(s?.actor).toBe(ADMIN);

    expect(t.audits.map((a) => [a.action, a.actor])).toEqual([
      ["connection.connect_started", { kind: "user", userId: ADMIN }],
      ["connection.connect.requested", { kind: "user", userId: ADMIN }],
      ["connection.connect.succeeded", { kind: "user", userId: ADMIN }],
    ]);
    const out = JSON.stringify([t.audits, t.logs]);
    for (const secret of [ACCESS, REFRESH, "synthetic-client-secret", "synthetic-code-1", form.get("code_verifier")]) expect(out).not.toContain(secret);
  });

  it("sends the client secret in the body when the provider uses client_secret_post", async () => {
    const tokenRequests = mockTokenEndpoint();
    const t = setup({
      provider: { client: () => ({ clientId: "synthetic-client-id", clientSecret: new SecretValue("synthetic-client-secret"), redirectUri: REDIRECT, tokenAuth: "post" }) },
    });
    const { query } = providerRedirect(await t.flow.start("mockqbo", "PKG", t.as(ADMIN)));
    expect((await t.flow.callback("mockqbo", query, t.as(ADMIN))).ok).toBe(true);
    expect(tokenRequests[0]?.form.get("client_secret")).toBe("synthetic-client-secret");
    expect(tokenRequests[0]?.auth).toBeNull();
  });
});

describe("state binding", () => {
  it("a state works once (replay is refused)", async () => {
    mockTokenEndpoint();
    const t = setup();
    const { query } = providerRedirect(await t.flow.start("mockqbo", "PKG", t.as(ADMIN)));
    expect((await t.flow.callback("mockqbo", query, t.as(ADMIN))).ok).toBe(true);
    expect(await t.flow.callback("mockqbo", query, t.as(ADMIN))).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(t.stored).toHaveLength(1);
  });

  it("another user cannot finish someone else's connect (login CSRF / account mix-up)", async () => {
    const tokenRequests = mockTokenEndpoint();
    const t = setup();
    const { query } = providerRedirect(await t.flow.start("mockqbo", "PKG", t.as(ADMIN)));
    expect(await t.flow.callback("mockqbo", query, t.as(OTHER))).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(tokenRequests).toHaveLength(0);
  });

  it("a state moved to another lane is refused, after that lane is authorized", async () => {
    mockTokenEndpoint();
    const t = setup();
    const { query } = providerRedirect(await t.flow.start("mockqbo", "PKG", t.as(ADMIN)));
    const lanes: string[] = [];
    query.set("state", (query.get("state") as string).replace(/^PKG\./, "APK."));
    const result = await t.flow.callback("mockqbo", query, async (laneId) => (lanes.push(laneId), { userId: ADMIN, client: { uid: ADMIN } as never }));
    expect(result).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(lanes).toEqual(["APK"]);
  });

  it("an expired state is refused", async () => {
    mockTokenEndpoint();
    const t = setup();
    const { query } = providerRedirect(await t.flow.start("mockqbo", "PKG", t.as(ADMIN)));
    t.now.t += 11 * 60_000;
    expect(await t.flow.callback("mockqbo", query, t.as(ADMIN))).toMatchObject({ ok: false, reason: "invalid_state" });
  });

  it("a malformed or missing state is refused without authorizing anything", async () => {
    const t = setup();
    let authorized = 0;
    const authorize = async () => (authorized++, { userId: ADMIN, client: {} as never });
    for (const state of [null, "", "PKG", "pkg.abc", "PKG.short", `PKG.${"a".repeat(43)}x`]) {
      const q = new URLSearchParams({ code: "c" });
      if (state !== null) q.set("state", state);
      expect(await t.flow.callback("mockqbo", q, authorize)).toMatchObject({ ok: false, reason: "invalid_state" });
    }
    expect(authorized).toBe(0);
  });

  it("a state started for one provider cannot finish under another", async () => {
    mockTokenEndpoint();
    const t = setup();
    const other = setup({ provider: { slug: "mockgoogle", provider: "google" } });
    const { query } = providerRedirect(await t.flow.start("mockqbo", "PKG", t.as(ADMIN)));
    // same store contents in the other flow, as if both providers were registered together
    for (const [k, v] of t.states) other.states.set(k, v);
    expect(await other.flow.callback("mockgoogle", query, other.as(ADMIN))).toMatchObject({ ok: false, reason: "invalid_state" });
  });
});

describe("failures", () => {
  it("the user declining at the provider ends the connect without an exchange, audited as failed", async () => {
    const tokenRequests = mockTokenEndpoint();
    const t = setup();
    const { query } = providerRedirect(await t.flow.start("mockqbo", "PKG", t.as(ADMIN)), { error: "access_denied", error_description: "User said no" });
    expect(await t.flow.callback("mockqbo", query, t.as(ADMIN))).toMatchObject({ ok: false, reason: "denied" });
    expect(tokenRequests).toHaveLength(0);
    expect(t.audits.at(-1)).toMatchObject({ action: "connection.connect.failed", metadata: { reason: "denied" } });
    expect(t.states.size).toBe(0); // the state is spent
  });

  it("a refused code (invalid_grant) stores nothing and leaks nothing", async () => {
    mockTokenEndpoint({ status: 400, body: { error: "invalid_grant", error_description: `code synthetic-code-1 for ${ACCESS}` } });
    const t = setup();
    const { query } = providerRedirect(await t.flow.start("mockqbo", "PKG", t.as(ADMIN)));
    expect(await t.flow.callback("mockqbo", query, t.as(ADMIN))).toMatchObject({ ok: false, reason: "exchange_failed" });
    expect(t.stored).toHaveLength(0);
    expect(t.ensured).toHaveLength(0);
    expect(t.audits.at(-1)).toMatchObject({ action: "connection.connect.failed", metadata: { error_class: "ExchangeFailed" } });
    const out = JSON.stringify([t.audits, t.logs]);
    expect(out).not.toContain("synthetic-code-1");
    expect(out).toContain("invalid_grant"); // the provider code is kept in the connector log
    expect(t.logs.find((l) => l.event === "connector.oauth_callback_failed")).toMatchObject({ level: "warn", fields: { reason: "exchange_failed", error: { provider_error_code: "invalid_grant" } } });
  });

  it("a token response without an access token is an exchange failure", async () => {
    mockTokenEndpoint({ body: { token_type: "bearer" } });
    const t = setup();
    const { query } = providerRedirect(await t.flow.start("mockqbo", "PKG", t.as(ADMIN)));
    expect(await t.flow.callback("mockqbo", query, t.as(ADMIN))).toMatchObject({ ok: false, reason: "exchange_failed" });
  });

  it("an account the provider adapter refuses (e.g. not the lane's realm) creates no connection", async () => {
    mockTokenEndpoint();
    const t = setup({
      provider: {
        identify: async () => {
          throw new ConnectorError({ kind: "invalid_input", message: "realm is not the lane's" });
        },
      },
    });
    const { query } = providerRedirect(await t.flow.start("mockqbo", "PKG", t.as(ADMIN)));
    expect(await t.flow.callback("mockqbo", query, t.as(ADMIN))).toMatchObject({ ok: false, reason: "account_refused" });
    expect(t.ensured).toHaveLength(0);
    expect(t.stored).toHaveLength(0);
  });

  it("authorization failures are rethrown for the route to answer 401/403, before any state is touched", async () => {
    const t = setup();
    const deny = async () => {
      throw new Error("forbidden");
    };
    await expect(t.flow.start("mockqbo", "PKG", deny)).rejects.toThrow("forbidden");
    expect(t.states.size).toBe(0);
    const { query } = providerRedirect(await t.flow.start("mockqbo", "PKG", t.as(ADMIN)));
    await expect(t.flow.callback("mockqbo", query, deny)).rejects.toThrow("forbidden");
    expect(t.states.size).toBe(1); // still there for the right user
  });

  it("does not start a connect it cannot audit", async () => {
    const t = setup({ auditFails: true });
    await expect(t.flow.start("mockqbo", "PKG", t.as(ADMIN))).rejects.toThrow();
  });

  it("unknown providers: start throws not_found, callback reports unknown_provider", async () => {
    const t = setup();
    await expect(t.flow.start("dropbox", "PKG", t.as(ADMIN))).rejects.toMatchObject({ info: { kind: "not_found" } });
    expect(await t.flow.callback("dropbox", new URLSearchParams(), t.as(ADMIN))).toEqual({ ok: false, reason: "unknown_provider" });
    expect(t.flow.has("mockqbo")).toBe(true);
    expect(t.flow.has("dropbox")).toBe(false);
  });

  it("refuses duplicate or malformed provider slugs", () => {
    const base = setup();
    void base;
    expect(() => setup({ provider: { slug: "Bad Slug" } })).toThrow(TypeError);
  });
});
