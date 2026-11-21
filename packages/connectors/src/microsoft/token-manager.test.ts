// Microsoft token refresh (T-256): proactive and on-demand refresh, single flight, rotation with compare-and-swap (V-8: the new
// refresh token replaces the old one and the old one is not revoked), a lost race, invalid_grant and its family ->
// reconnect_required (V-7), a refresh that is never retried, and secrets never logged.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { createMicrosoftHarness, TENANT_A, TENANT_B } from "../testing/microsoft-harness";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft, FAKE_GRAPH_CLIENT_ID, FAKE_GRAPH_CLIENT_SECRET, MICROSOFT_ERROR_TEXT_CANARY } from "../testing/msw/microsoft/handlers";
import { SecretValue } from "../vault/secret";
import { REFRESH_SKEW_MS } from "./constants";
import { RECONNECT_ERRORS } from "./token-manager";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const EXEC = "exec@pubkgroup.example.test";

async function setup(opts: { tenant?: string } = {}) {
  const fake = createFakeMicrosoft();
  server.use(...fake.handlers);
  const h = createMicrosoftHarness({ fake, lanes: { PKG: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A, TENANT_B] }, domains: ["pubkgroup.example.test"] } } });
  const c = h.connect("PKG", EXEC, opts.tenant ? { tenant: opts.tenant } : {});
  const g = await h.guard("PKG", c.conn);
  return { fake, h, g, ...c };
}
async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isConnectorError(e) ? e.info.kind : "other";
  }
  return "no error";
}

describe("access tokens", () => {
  it("uses the stored access token while it is fresh, with no request to Microsoft", async () => {
    const { fake, h, g } = await setup();
    const t = await h.tokens.accessToken("PKG", g);
    expect(t.reveal()).toBe(h.storedSet(g.conn.id)?.access_token);
    expect(fake.state.tokenRequests).toEqual([]);
  });

  it("refreshes when less than 5 minutes are left, not when more", async () => {
    const { fake, h, g } = await setup();
    const set = h.storedSet(g.conn.id) as Record<string, unknown>;
    // 6 minutes left: fresh. 4 minutes left: stale.
    const withLeft = (ms: number) => h.secrets.set(g.conn.id, JSON.stringify({ ...set, expires_in: 3600, obtained_at: new Date(Date.now() - 3600_000 + ms).toISOString() }));
    withLeft(REFRESH_SKEW_MS + 60_000);
    await h.tokens.accessToken("PKG", g);
    expect(fake.state.tokenRequests).toHaveLength(0);
    withLeft(REFRESH_SKEW_MS - 60_000);
    await h.tokens.accessToken("PKG", g);
    expect(fake.state.tokenRequests).toHaveLength(1);
  });

  it("refreshes an expired one at the connection's own tenant with the client secret in the body", async () => {
    const { fake, h, g } = await setup({ tenant: TENANT_B });
    const before = h.storedSet(g.conn.id);
    h.expireStoredAccess(g.conn.id);
    const t = await h.tokens.accessToken("PKG", g);
    expect(fake.state.tokenRequests).toHaveLength(1);
    expect(fake.state.tokenRequests[0]?.tenant).toBe(TENANT_B);
    expect(fake.state.tokenRequests[0]?.fields).toMatchObject({ grant_type: "refresh_token", client_id: FAKE_GRAPH_CLIENT_ID, client_secret: FAKE_GRAPH_CLIENT_SECRET, refresh_token: before?.refresh_token });
    expect(t.reveal()).toBe(h.storedSet(g.conn.id)?.access_token);
    expect(h.stats.rotations).toBe(1);
  });

  it("V-8: the new refresh token REPLACES the stored one (the old one is not kept), although Microsoft would still accept the old one", async () => {
    const { fake, h, g, account } = await setup();
    const oldRefresh = h.storedSet(g.conn.id)?.refresh_token as string;
    h.expireStoredAccess(g.conn.id);
    await h.tokens.accessToken("PKG", g);
    const after = h.storedSet(g.conn.id);
    expect(after?.refresh_token).not.toBe(oldRefresh);
    expect(after?.refresh_token).toBe(account.refreshToken);
    expect(JSON.stringify(after)).not.toContain(oldRefresh);
    expect(account.refreshTokens.has(oldRefresh)).toBe(true); // the fake did not revoke it
    expect(fake.state.refreshes).toBe(1);
    // The next refresh uses the NEW token.
    h.expireStoredAccess(g.conn.id);
    await h.tokens.accessToken("PKG", g);
    expect(fake.state.tokenRequests[1]?.fields.refresh_token).toBe(after?.refresh_token);
  });

  it("keeps the old refresh token when a response carries none, and stores no refresh-token expiry (V-8)", async () => {
    const { h, g } = await setup();
    const oldRefresh = h.storedSet(g.conn.id)?.refresh_token;
    server.use(http.post("https://login.microsoftonline.com/:tenant/oauth2/v2.0/token", () => HttpResponse.json({ token_type: "Bearer", expires_in: 3599, access_token: "synthetic-ms-access-norefresh-1" })));
    h.expireStoredAccess(g.conn.id);
    await h.tokens.accessToken("PKG", g);
    expect(h.storedSet(g.conn.id)).toMatchObject({ refresh_token: oldRefresh, access_token: "synthetic-ms-access-norefresh-1" });
    expect(h.rows.get(g.conn.id)?.token_expires_at).toBeNull();
  });

  it("is single flight within a process", async () => {
    const { fake, h, g } = await setup();
    h.expireStoredAccess(g.conn.id);
    const all = await Promise.all([1, 2, 3, 4].map(() => h.tokens.accessToken("PKG", g)));
    expect(new Set(all.map((t) => t.reveal())).size).toBe(1);
    expect(fake.state.refreshes).toBe(1);
  });

  it("a lost refresh race: two instances refresh at once, the compare-and-swap loser discards its result and re-reads the winner's", async () => {
    const { fake, h, g, account } = await setup();
    h.expireStoredAccess(g.conn.id);
    const other = h.newTokenManager();
    const [a, b] = await Promise.all([h.tokens.accessToken("PKG", g), other.accessToken("PKG", g)]);
    // Both refreshed at Microsoft (the old refresh token stays valid, so neither fails), but only one rotation was stored.
    expect(fake.state.refreshes).toBe(2);
    expect(h.stats.rotations).toBe(1);
    expect(a.reveal()).toBe(b.reveal());
    expect(a.reveal()).toBe(h.storedSet(g.conn.id)?.access_token);
    // The stored refresh token is one the fake issued, and exactly one (the loser's was dropped, not stored beside it).
    const stored = h.storedSet(g.conn.id);
    expect(account.refreshTokens.has(stored?.refresh_token as string)).toBe(true);
    expect(h.logs.some((l) => l.event === "connector.token_refresh_lost_race")).toBe(true);
  });

  it("invalid_grant while another instance has meanwhile stored a newer set is NOT reconnect_required: the newer set is used", async () => {
    const { fake, h, g } = await setup();
    h.expireStoredAccess(g.conn.id);
    let release: () => void = () => undefined;
    fake.state.refreshHold = new Promise<void>((r) => (release = r));
    fake.state.failRefresh = { status: 400, error: "invalid_grant", codes: [70008] };
    const pending = h.tokens.accessToken("PKG", g);
    await vi.waitFor(() => expect(fake.state.tokenRequests).toHaveLength(1)); // our refresh is at Microsoft, held
    // The other instance's refresh finished and stored its set while ours was in flight.
    const winner = JSON.stringify({ access_token: "synthetic-ms-access-winner-1", refresh_token: "synthetic-ms-refresh-winner-1", expires_in: 3599, obtained_at: new Date().toISOString() });
    h.secrets.set(g.conn.id, winner);
    release();
    expect((await pending).reveal()).toBe("synthetic-ms-access-winner-1");
    expect(h.reconnects).toEqual([]);
  });

  it.each([...RECONNECT_ERRORS])("`%s` from the token endpoint is reconnect_required, never retried, and the stored set is kept for T-195", async (error) => {
    const { fake, h, g } = await setup();
    h.expireStoredAccess(g.conn.id);
    fake.state.failRefresh = { status: 400, error, codes: [50173] };
    expect(await kindOf(h.tokens.accessToken("PKG", g))).toBe("reconnect_required");
    expect(fake.state.tokenRequests).toHaveLength(1);
    expect(h.secrets.has(g.conn.id)).toBe(true);
    expect(h.reconnects).toHaveLength(1);
    expect(h.reconnects[0]).toMatchObject({ kind: "reconnect_required", provider_error_code: error });
  });

  it("a revoked grant at Microsoft (the fake answers invalid_grant) is reconnect_required", async () => {
    const { h, g, account } = await setup();
    account.revoked = true;
    h.expireStoredAccess(g.conn.id);
    expect(await kindOf(h.tokens.accessToken("PKG", g))).toBe("reconnect_required");
  });

  it("a wrong client (invalid_client) is a configuration fault, not reconnect_required, and records nothing", async () => {
    const { fake, h, g } = await setup();
    fake.state.failRefresh = { status: 401, error: "invalid_client", codes: [7000215] };
    h.expireStoredAccess(g.conn.id);
    expect(await kindOf(h.tokens.accessToken("PKG", g))).toBe("forbidden");
    expect(h.reconnects).toEqual([]);
  });

  it("a 503 from the token endpoint is not reconnect_required and the refresh is not retried", async () => {
    const { fake, h, g } = await setup();
    fake.state.failRefresh = { status: 503, error: "temporarily_unavailable" };
    h.expireStoredAccess(g.conn.id);
    expect(await kindOf(h.tokens.accessToken("PKG", g))).toBe("transient");
    expect(fake.state.tokenRequests).toHaveLength(1);
    expect(h.reconnects).toEqual([]);
  });

  it("a 429 from the token endpoint is not retried either (the refresh POST is never repeated)", async () => {
    const { fake, h, g } = await setup();
    fake.state.failRefresh = { status: 429, error: "throttled" };
    h.expireStoredAccess(g.conn.id);
    expect(await kindOf(h.tokens.accessToken("PKG", g))).toBe("rate_limited");
    expect(fake.state.tokenRequests).toHaveLength(1);
  });

  it("with `rejected` it refreshes once; if the stored token already moved on, it just returns it", async () => {
    const { fake, h, g } = await setup();
    const used = new SecretValue(h.storedSet(g.conn.id)?.access_token as string);
    const t1 = await h.tokens.accessToken("PKG", g, { rejected: used });
    expect(fake.state.refreshes).toBe(1);
    expect(t1.reveal()).not.toBe(used.reveal());
    const t2 = await h.tokens.accessToken("PKG", g, { rejected: used });
    expect(fake.state.refreshes).toBe(1);
    expect(t2.reveal()).toBe(t1.reveal());
  });

  it("refuses a connection the guard did not approve before reading any token", async () => {
    const { h, g } = await setup();
    const forged = { conn: g.conn, tenantId: g.tenantId, cloud: g.cloud };
    expect(await kindOf(h.tokens.accessToken("PKG", forged as never))).toBe("forbidden");
    expect(h.stats.tokenReads).toBe(0);
  });

  it("a stored value that is not a token set is a provider_error that does not echo it", async () => {
    const { h, g } = await setup();
    h.secrets.set(g.conn.id, "not-json-secret-material-123");
    let message = "";
    try {
      await h.tokens.accessToken("PKG", g);
    } catch (e) {
      message = e instanceof Error ? e.message : "";
    }
    expect(message).toMatch(/not a Microsoft token set/);
    expect(message).not.toContain("secret-material");
  });

  it("an unreadable Vault after a failed refresh is a transient outage, never reconnect_required", async () => {
    const { fake, h, g } = await setup();
    h.expireStoredAccess(g.conn.id);
    let release: () => void = () => undefined;
    fake.state.refreshHold = new Promise<void>((r) => (release = r));
    fake.state.failRefresh = { status: 400, error: "invalid_grant" };
    const pending = h.tokens.accessToken("PKG", g);
    await vi.waitFor(() => expect(fake.state.tokenRequests).toHaveLength(1));
    h.secrets.set(g.conn.id, "garbage");
    release();
    expect(await kindOf(pending)).toBe("transient");
    expect(h.reconnects).toEqual([]);
  });

  it("error text from Microsoft is never in the error that leaves", async () => {
    const { fake, h, g } = await setup();
    fake.state.failRefresh = { status: 400, error: "invalid_grant", codes: [70008] };
    h.expireStoredAccess(g.conn.id);
    let text = "";
    try {
      await h.tokens.accessToken("PKG", g);
    } catch (e) {
      text = JSON.stringify({ m: (e as Error).message, i: isConnectorError(e) ? e.toJSON() : null });
    }
    expect(text).not.toContain(MICROSOFT_ERROR_TEXT_CANARY);
    expect(JSON.stringify(h.reconnects)).not.toContain(MICROSOFT_ERROR_TEXT_CANARY);
  });
});
