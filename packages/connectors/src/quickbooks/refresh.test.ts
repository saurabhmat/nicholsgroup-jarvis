// Token refresh (QB-2, T-050): proactive refresh before expiry, refresh on a 401, the rotating refresh token stored
// atomically with the old one discarded, and a concurrent refresh that does not lose the token. Mocks only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { createQboHarness, type QboHarness } from "../testing/quickbooks-harness";
import { API_SANDBOX, createFakeIntuit, FAKE_REALM, OAUTH_TOKEN } from "../testing/msw/quickbooks/handlers";

const server = useMockServer();
function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a value");
  return v;
}
const LANE = "PKG";

afterEach(() => {
  RateLimiter.resetForTests();
});

async function setup(intuitOptions: Parameters<typeof createFakeIntuit>[0] = {}, realms: Record<string, string | null> = {}) {
  const intuit = createFakeIntuit(intuitOptions);
  server.use(...intuit.handlers);
  const h = createQboHarness({ intuit, realms });
  const conn = await h.connectViaCallback(LANE);
  intuit.state.apiRequests.length = 0; // the connect callback's own CompanyInfo check is not under test here
  return { intuit, h, conn };
}

const refreshCalls = (i: ReturnType<typeof createFakeIntuit>) => i.state.tokenRequests.filter((r) => r.grant === "refresh_token");
const stored = (h: QboHarness, id: string) => h.storedSet(id) as { access_token: string; refresh_token: string; obtained_at: string };

describe("proactive refresh", () => {
  it("uses the stored access token while it has more than 5 minutes left", async () => {
    const { intuit, h, conn } = await setup();
    h.clock.t += 54 * 60_000; // 54 minutes into a 60 minute token
    const token = await h.tokens.accessToken(LANE, conn);
    expect(token.reveal()).toBe(intuit.state.issued[0]?.access);
    expect(refreshCalls(intuit)).toHaveLength(0);
  });

  it("refreshes before expiry, stores the rotated refresh token and drops the old one", async () => {
    const { intuit, h, conn } = await setup();
    const first = need(intuit.state.issued[0]);
    h.clock.t += 56 * 60_000; // 4 minutes left: inside the refresh window
    const token = await h.tokens.accessToken(LANE, conn);
    const second = need(intuit.state.issued[1]);
    expect(token.reveal()).toBe(second.access);
    expect(refreshCalls(intuit)).toHaveLength(1);
    expect(refreshCalls(intuit)[0]?.form.get("refresh_token")).toBe(first.refresh);
    // The Vault now holds exactly the new set: new refresh token, no trace of the old one.
    const set = stored(h, conn.id);
    expect(set.access_token).toBe(second.access);
    expect(set.refresh_token).toBe(second.refresh);
    expect(h.secrets.get(conn.id)).not.toContain(first.refresh);
    expect(set.obtained_at).toBe(new Date(h.clock.t).toISOString());
    expect(h.stats.rotations).toBe(1);
    // Next call within the new hour does not refresh again.
    await h.tokens.accessToken(LANE, conn);
    expect(refreshCalls(intuit)).toHaveLength(1);
  });

  it("records the refresh token's new expiry on the connection", async () => {
    const { h, conn } = await setup({ refreshExpiresIn: 8_000_000 });
    h.clock.t += 59 * 60_000;
    await h.tokens.accessToken(LANE, conn);
    expect(h.rows.get(conn.id)?.token_expires_at).toBe(new Date(h.clock.t + 8_000_000 * 1000).toISOString());
  });

  it("authenticates the refresh with the client credentials (Basic) and sends a form", async () => {
    const { intuit, h, conn } = await setup();
    h.clock.t += 59 * 60_000;
    await h.tokens.accessToken(LANE, conn);
    const req = need(refreshCalls(intuit)[0]);
    expect(req.auth).toMatch(/^Basic /);
    expect([...req.form.keys()].sort()).toEqual(["grant_type", "refresh_token"]);
  });
});

describe("refresh on a 401", () => {
  it("refreshes once and retries once when Intuit rejects the access token", async () => {
    const { intuit, h, conn } = await setup();
    intuit.expireAccess(need(intuit.state.issued[0]).access); // still "fresh" locally, rejected by Intuit
    const res = await h.api.get(LANE, conn, "/v3/company/{realm}/companyinfo/{realm}", { realm: FAKE_REALM });
    expect(res.status).toBe(200);
    expect(refreshCalls(intuit)).toHaveLength(1);
    expect(intuit.state.apiRequests).toHaveLength(2);
    expect(intuit.state.apiRequests[0]?.authorization).toBe(`Bearer ${intuit.state.issued[0]?.access}`);
    expect(intuit.state.apiRequests[1]?.authorization).toBe(`Bearer ${intuit.state.issued[1]?.access}`);
    expect(stored(h, conn.id).refresh_token).toBe(intuit.state.issued[1]?.refresh);
  });

  it("a second 401 after the refresh is final (no loop) and is a forbidden/401 error", async () => {
    const { intuit, h, conn } = await setup();
    intuit.state.reject401 = 5;
    const err = (await h.api.get(LANE, conn, "/v3/company/{realm}/companyinfo/{realm}", { realm: FAKE_REALM }).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.info.kind).toBe("forbidden");
    expect(err.info.http_status).toBe(401);
    expect(refreshCalls(intuit)).toHaveLength(1);
    expect(intuit.state.apiRequests).toHaveLength(2);
  });

  it("an expired access token that Intuit rejects is replaced by the one another caller already stored (no second refresh)", async () => {
    const { intuit, h, conn } = await setup();
    const stale = h.tokens;
    const rejectedToken = await stale.accessToken(LANE, conn);
    h.clock.t += 56 * 60_000;
    const fresh = await h.tokens.accessToken(LANE, conn); // another caller refreshed
    expect(refreshCalls(intuit)).toHaveLength(1);
    const again = await h.tokens.accessToken(LANE, conn, { rejected: rejectedToken });
    expect(again.reveal()).toBe(fresh.reveal());
    expect(refreshCalls(intuit)).toHaveLength(1);
  });
});

describe("concurrent refresh does not lose the rotating token", () => {
  it("callers in one process share one refresh request", async () => {
    const { intuit, h, conn } = await setup({ tokenDelayMs: 20 });
    h.clock.t += 59 * 60_000;
    const out = await Promise.all(Array.from({ length: 6 }, () => h.tokens.accessToken(LANE, conn)));
    expect(refreshCalls(intuit)).toHaveLength(1);
    expect(new Set(out.map((t) => t.reveal())).size).toBe(1);
    expect(stored(h, conn.id).access_token).toBe(out[0]?.reveal());
  });

  it("two instances refreshing at once: exactly one rotation lands, the loser uses the winner's token, and the stored refresh token is one Intuit still accepts", async () => {
    const { intuit, h, conn } = await setup({ tokenDelayMs: 25 });
    const instanceA = h.newTokenManager();
    const instanceB = h.newTokenManager();
    h.clock.t += 59 * 60_000;
    const [a, b] = await Promise.all([instanceA.accessToken(LANE, conn), instanceB.accessToken(LANE, conn)]);
    // Both instances really did call Intuit with the same old refresh token (the race happened).
    expect(refreshCalls(intuit)).toHaveLength(2);
    expect(new Set(refreshCalls(intuit).map((r) => r.form.get("refresh_token"))).size).toBe(1);
    expect(intuit.state.issued).toHaveLength(3);
    // One store won, one lost its compare-and-swap.
    expect(h.stats.rotations).toBe(1);
    expect(h.stats.lostRaces).toBe(1);
    // Both callers ended up with the token that is actually stored.
    const set = stored(h, conn.id);
    expect(a.reveal()).toBe(set.access_token);
    expect(b.reveal()).toBe(set.access_token);
    // The stored refresh token is a real, still-valid one: the next refresh works.
    expect(intuit.state.validRefresh.has(set.refresh_token)).toBe(true);
    h.clock.t += 59 * 60_000;
    const next = await h.tokens.accessToken(LANE, conn);
    expect(next.reveal()).toBe(intuit.state.issued.at(-1)?.access);
    expect(h.logs.filter((l) => l.event === "connector.token_refresh_lost_race")).toHaveLength(1);
  });

  it("strict Intuit (no grace period): the loser's refresh is invalid_grant, yet it ends up with the winner's tokens (security M4)", async () => {
    const { intuit, h, conn } = await setup({ tokenDelayMs: 25, strictRotation: true });
    const instanceA = h.newTokenManager();
    const instanceB = h.newTokenManager();
    h.clock.t += 59 * 60_000;
    const [a, b] = await Promise.all([instanceA.accessToken(LANE, conn), instanceB.accessToken(LANE, conn)]);
    // Both really called Intuit with the same refresh token; one was refused because the winner's rotation replaced it.
    expect(refreshCalls(intuit)).toHaveLength(2);
    expect(new Set(refreshCalls(intuit).map((r) => r.form.get("refresh_token"))).size).toBe(1);
    expect(intuit.state.issued).toHaveLength(2); // the first connect, one successful refresh
    // The loser did not report reconnect_required: both callers hold the stored (winner's) token.
    const set = stored(h, conn.id);
    expect(a.reveal()).toBe(set.access_token);
    expect(b.reveal()).toBe(set.access_token);
    expect(h.stats.rotations).toBe(1);
    expect(intuit.state.validRefresh.has(set.refresh_token)).toBe(true);
    expect(h.logs.filter((l) => l.event === "connector.token_refresh_lost_race")).toHaveLength(1);
    // The refresh POST was never repeated.
    expect(refreshCalls(intuit)).toHaveLength(2);
  });

  it("the refresh POST is not retried when the response is lost; if the store moved on meanwhile, that set is used", async () => {
    const { intuit, h, conn } = await setup({ strictRotation: true });
    const before = h.secrets.get(conn.id);
    let posts = 0;
    server.use(
      http.post(OAUTH_TOKEN, async () => {
        posts += 1;
        // Another instance won while this request was in flight: store its set, then lose our response.
        const { SecretValue } = await import("../vault/secret");
        await h.vault.rotateToken(LANE, conn, new SecretValue(JSON.stringify({ access_token: "synthetic-winner-access", refresh_token: "synthetic-winner-refresh", expires_in: 3600, obtained_at: new Date(h.clock.t).toISOString() })), null, new SecretValue(before ?? ""));
        return HttpResponse.error();
      }),
    );
    h.clock.t += 59 * 60_000;
    const token = await h.tokens.accessToken(LANE, conn);
    expect(posts).toBe(1);
    expect(token.reveal()).toBe("synthetic-winner-access");
    void intuit;
  });

  it("a timeout with nothing new in the store reports the failure (not reconnect_required) and does not retry", async () => {
    const { h, conn } = await setup();
    let posts = 0;
    server.use(
      http.post(OAUTH_TOKEN, () => {
        posts += 1;
        return HttpResponse.error();
      }),
    );
    h.clock.t += 59 * 60_000;
    const err = (await h.tokens.accessToken(LANE, conn).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.info.kind).not.toBe("reconnect_required");
    expect(posts).toBe(1);
  });

  it("a stale writer cannot overwrite a newer set (the compare-and-swap itself)", async () => {
    const { h, conn } = await setup();
    const before = need(h.secrets.get(conn.id));
    const { SecretValue } = await import("../vault/secret");
    expect(await h.vault.rotateToken(LANE, conn, new SecretValue("{\"x\":\"newer-set-value\"}"), null, new SecretValue(before))).toBe(true);
    expect(await h.vault.rotateToken(LANE, conn, new SecretValue("{\"x\":\"stale-writer-value\"}"), null, new SecretValue(before))).toBe(false);
    expect(h.secrets.get(conn.id)).toBe("{\"x\":\"newer-set-value\"}");
  });
});

describe("failures", () => {
  it("invalid_grant is reconnect_required, is never retried, and keeps the stored set", async () => {
    const { intuit, h, conn } = await setup();
    intuit.state.failRefresh = { status: 400, error: "invalid_grant", always: true };
    const before = h.secrets.get(conn.id);
    h.clock.t += 59 * 60_000;
    const err = (await h.tokens.accessToken(LANE, conn).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.info.kind).toBe("reconnect_required");
    expect(err.info.disposition).toBe("reconnect_required");
    expect(err.info.provider_error_code).toBe("invalid_grant");
    expect(refreshCalls(intuit)).toHaveLength(1);
    expect(h.secrets.get(conn.id)).toBe(before);
  });

  it("an expired refresh token (Intuit no longer knows it) is invalid_grant too", async () => {
    const { intuit, h, conn } = await setup();
    intuit.state.validRefresh.clear();
    h.clock.t += 59 * 60_000;
    await expect(h.tokens.accessToken(LANE, conn)).rejects.toMatchObject({ info: { kind: "reconnect_required" } });
  });

  it("invalid_client is a failure with the code, not a reconnect", async () => {
    const { intuit, h, conn } = await setup();
    intuit.state.failRefresh = { status: 401, error: "invalid_client" };
    h.clock.t += 59 * 60_000;
    const err = (await h.tokens.accessToken(LANE, conn).catch((e: unknown) => e)) as ConnectorError;
    expect(err.info.kind).toBe("forbidden");
    expect(err.info.provider_error_code).toBe("invalid_client");
  });

  it("a transient token endpoint failure is NOT retried (the request may have been processed) and keeps the old refresh token", async () => {
    const { h, conn } = await setup();
    const before = h.secrets.get(conn.id);
    let calls = 0;
    server.use(
      http.post(OAUTH_TOKEN, () => {
        calls += 1;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    h.clock.t += 59 * 60_000;
    await expect(h.tokens.accessToken(LANE, conn)).rejects.toMatchObject({ info: { kind: "transient" } });
    expect(calls).toBe(1);
    expect(h.secrets.get(conn.id)).toBe(before);
  });

  it("a malformed stored credential is a provider_error that never echoes the stored text", async () => {
    const { h, conn } = await setup();
    h.secrets.set(conn.id, "not json at all synthetic-secret-text");
    const err = (await h.tokens.accessToken(LANE, conn).catch((e: unknown) => e)) as ConnectorError;
    expect(err.info.kind).toBe("provider_error");
    expect(JSON.stringify(err)).not.toContain("synthetic-secret-text");
  });

  it("refuses a connection from another lane before touching the Vault", async () => {
    const { h, conn } = await setup();
    await expect(h.tokens.accessToken("APK", conn)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
  });

  it("a Playground-style or foreign token set (no refresh token) cannot be used", async () => {
    const { h, conn } = await setup();
    h.secrets.set(conn.id, JSON.stringify({ access_token: "playground-access-token-1", obtained_at: new Date(h.clock.t).toISOString() }));
    await expect(h.tokens.accessToken(LANE, conn)).rejects.toMatchObject({ info: { kind: "provider_error" } });
  });
});

describe("tokens stay out of logs and errors", () => {
  it("no access or refresh token appears in any log line across connect, refresh, a 401 and a failure", async () => {
    const { intuit, h, conn } = await setup();
    intuit.expireAccess(need(intuit.state.issued[0]).access);
    await h.api.get(LANE, conn, "/v3/company/{realm}/companyinfo/{realm}", { realm: FAKE_REALM });
    intuit.state.failRefresh = { status: 400, error: "invalid_grant", always: true };
    h.clock.t += 59 * 60_000;
    await h.tokens.accessToken(LANE, conn).catch(() => undefined);
    const text = JSON.stringify(h.logs);
    expect(h.logs.length).toBeGreaterThan(3);
    for (const pair of intuit.state.issued) {
      expect(text).not.toContain(pair.access);
      expect(text).not.toContain(pair.refresh);
    }
    expect(text).not.toContain("synthetic-intuit-client-secret");
    expect(text).not.toMatch(/Bearer |Basic /);
    void API_SANDBOX;
  });
});
