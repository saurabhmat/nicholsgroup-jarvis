// The guarded Graph client (T-256): host and path allow-list, per-mailbox concurrency, Retry-After, per-connection isolation under a
// 429 storm, the error map, the T-196 error log, and the token canary.
import { afterEach, describe, expect, it } from "vitest";
import { isConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { createMicrosoftHarness, TENANT_A, TENANT_B, type MicrosoftHarness } from "../testing/microsoft-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft, FAKE_GRAPH_CLIENT_SECRET, MICROSOFT_ERROR_TEXT_CANARY } from "../testing/msw/microsoft/handlers";
import { resetMailboxSlotsForTests, withMailboxSlot } from "./concurrency";
import { createGraphHttp } from "./http";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
  resetMailboxSlotsForTests();
});

const EXEC = "exec@pubkgroup.example.test";
const OTHER = "other@pubkgroup.example.test";

function setup(over: { sleep?: (ms: number) => Promise<void>; maxConcurrent?: number } = {}) {
  const fake = createFakeMicrosoft();
  server.use(...fake.handlers);
  const h = createMicrosoftHarness({
    fake,
    lanes: { PKG: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A, TENANT_B] }, domains: ["pubkgroup.example.test"] } },
    ...over,
  });
  return { fake, h };
}
async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (isConnectorError(e)) return e;
    throw e;
  }
  throw new Error("expected a ConnectorError");
}
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const allText = (h: MicrosoftHarness, extra: unknown[] = []) => JSON.stringify([h.logs, h.apiErrors, h.reconnects, ...extra]);

describe("hosts and paths", () => {
  const opts = { laneId: "PKG" as const };
  it("only the commercial hosts are allowed; any other host is refused when the client is built, before a token could be read", () => {
    for (const baseUrl of ["https://graph.microsoft.com/v1.0", "https://graph.microsoft.com"]) expect(() => createGraphHttp({ ...opts, baseUrl }, "commercial", "api")).not.toThrow();
    expect(() => createGraphHttp({ ...opts, baseUrl: "https://login.microsoftonline.com" }, "commercial", "token")).not.toThrow();
    for (const baseUrl of ["https://graph.microsoft.us/v1.0", "https://evil.example.test/v1.0", "https://graph.microsoft.com.evil.example.test", "http://localhost:9999", "https://login.microsoftonline.com"]) {
      expect(() => createGraphHttp({ ...opts, baseUrl }, "commercial", "api"), baseUrl).toThrow(/allowed Microsoft host/);
    }
    // the token host is not a Graph host and the Graph host is not a token host
    expect(() => createGraphHttp({ ...opts, baseUrl: "https://graph.microsoft.com" }, "commercial", "token")).toThrow(/allowed Microsoft host/);
  });

  it("every gcc_high host is refused until T-267", () => {
    for (const baseUrl of ["https://graph.microsoft.us/v1.0", "https://login.microsoftonline.us", "https://graph.microsoft.com/v1.0", "https://login.microsoftonline.com"]) {
      expect(() => createGraphHttp({ ...opts, baseUrl }, "gcc_high", "api"), baseUrl).toThrow(/allowed Microsoft host/);
      expect(() => createGraphHttp({ ...opts, baseUrl }, "gcc_high", "token"), baseUrl).toThrow(/allowed Microsoft host/);
    }
  });

  it("only /me paths are reachable on Graph: another user's mailbox is refused before any token read or request", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", EXEC);
    for (const path of ["/users/{id}/messages", "/me/../users/x", "/meeting", "/me?$select=id", "/"]) {
      const e = await failure(h.api.get("PKG", conn, path, { id: "someone" }));
      expect(e.info.kind, path).toBe("invalid_input");
    }
    expect(h.stats.tokenReads).toBe(0);
    expect(fake.state.graphRequests).toHaveLength(0);
    expect(fake.state.tokenRequests).toHaveLength(0);
  });

  it("calls /v1.0/me with a bearer token and the request id header is captured", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", EXEC);
    const res = await h.api.get("PKG", conn, "/me", undefined, { $select: "id" });
    expect(res.status).toBe(200);
    expect(res.providerTid).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.state.graphRequests[0]).toMatchObject({ method: "GET", path: "/v1.0/me", address: EXEC });
    expect(fake.state.graphRequests[0]?.authorization).toMatch(/^Bearer synthetic-ms-access-/);
  });
});

describe("concurrency, pacing and Retry-After", () => {
  it("at most 4 requests are in flight for one mailbox, the rest wait for a slot", async () => {
    const { h, fake } = setup();
    const { conn, account } = h.connect("PKG", EXEC);
    let release: () => void = () => undefined;
    fake.state.hold = new Promise<void>((r) => (release = r));
    const calls = Array.from({ length: 9 }, () => h.api.get("PKG", conn, "/me"));
    await settle(150);
    expect(account.inflight).toBe(4);
    release();
    const results = await Promise.all(calls);
    expect(results).toHaveLength(9);
    expect(account.maxInflight).toBe(4);
  });

  it("the cap is per mailbox: another mailbox is served while the first one's slots are full", async () => {
    const { h, fake } = setup({ maxConcurrent: 1 });
    const a = h.connect("PKG", EXEC);
    const b = h.connect("PKG", OTHER);
    let release: () => void = () => undefined;
    fake.state.hold = new Promise<void>((r) => (release = r));
    const first = h.api.get("PKG", a.conn, "/me");
    const queued = h.api.get("PKG", a.conn, "/me");
    await settle(100);
    expect(a.account.inflight).toBe(1);
    release();
    await Promise.all([first, queued, h.api.get("PKG", b.conn, "/me")]);
    expect(a.account.maxInflight).toBe(1);
  });

  it("Retry-After on 503 and 429 is honoured by the shared client: it is the wait before the retry", async () => {
    const waits: number[] = [];
    const { h, fake } = setup({ sleep: async (ms) => void waits.push(ms) });
    const { conn, account } = h.connect("PKG", EXEC);
    account.throttle = { status: 503, retryAfter: 7, remaining: 1 };
    const res = await h.api.get("PKG", conn, "/me");
    expect(res.attempts).toBe(2);
    expect(waits).toContain(7000);
    account.throttle = { status: 429, retryAfter: 3, remaining: 1 };
    await h.api.get("PKG", conn, "/me");
    expect(waits).toContain(3000);
    expect(fake.state.graphRequests.length).toBe(4);
  });

  it("a 429 storm on one tenant does not delay another tenant's mailbox", async () => {
    // Retry-After 30 s: the stormed mailbox's requests sleep on a gate (a wait of 10 s or more); other waits pass at once.
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((r) => (openGate = r));
    const sleep = (ms: number) => (ms >= 10_000 ? gate : Promise.resolve());
    const { h } = setup({ sleep });
    const a = h.connect("PKG", EXEC, { tenant: TENANT_A });
    const b = h.connect("PKG", OTHER, { tenant: TENANT_B });
    a.account.throttle = { status: 429, retryAfter: 30, remaining: Infinity };
    const storm = Array.from({ length: 7 }, () => h.api.get("PKG", a.conn, "/me").then(() => "ok", (e: unknown) => (isConnectorError(e) ? e.info.kind : "other")));
    await settle(150);
    let stormDone = false;
    void Promise.all(storm).then(() => (stormDone = true));
    // Tenant B is served at once while all of tenant A's requests are still waiting on Retry-After.
    const started = Date.now();
    const res = await h.api.get<{ mail: string }>("PKG", b.conn, "/me");
    expect(res.data.mail).toBe(OTHER);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(stormDone).toBe(false);
    expect(a.account.maxInflight).toBeLessThanOrEqual(4);
    openGate();
    const outcomes = await Promise.all(storm);
    expect(new Set(outcomes)).toEqual(new Set(["rate_limited"]));
  });

  it("paces reads per connection at 4 requests/s, and each connection has its own bucket", async () => {
    const { h } = setup();
    const a = h.connect("PKG", EXEC);
    const b = h.connect("PKG", OTHER);
    for (let i = 0; i < 4; i++) await h.api.get("PKG", a.conn, "/me");
    await h.api.get("PKG", b.conn, "/me");
    expect(h.clock.waits).toEqual([]); // four calls in one second pass, and the other mailbox is not held back by them
    await h.api.get("PKG", a.conn, "/me"); // the fifth within a second waits for the window
    expect(h.clock.waits).toHaveLength(1);
    expect(h.clock.waits[0]).toBeGreaterThan(0);
    expect(h.clock.waits[0]).toBeLessThanOrEqual(1000);
  });

  it("a rate-limited error carries the Retry-After the client saw, and a fixed message", async () => {
    const { h } = setup({ sleep: async () => undefined });
    const { conn, account } = h.connect("PKG", EXEC);
    account.throttle = { status: 429, retryAfter: 12, remaining: Infinity };
    const e = await failure(h.api.get("PKG", conn, "/me"));
    expect(e.info).toMatchObject({ kind: "rate_limited", http_status: 429, retry_after_seconds: 12, disposition: "retry" });
    expect(e.message).not.toContain(MICROSOFT_ERROR_TEXT_CANARY);
  });
});

describe("withMailboxSlot", () => {
  it("passes a slot on when the work throws, and when a waiter is aborted", async () => {
    await expect(withMailboxSlot("k", 1, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    let release: () => void = () => undefined;
    const holder = withMailboxSlot("k", 1, () => new Promise<void>((r) => (release = r)));
    const ac = new AbortController();
    const waiting = withMailboxSlot("k", 1, async () => "never", ac.signal);
    ac.abort();
    await expect(waiting).rejects.toBeDefined();
    const next = withMailboxSlot("k", 1, async () => "next");
    release();
    await holder;
    await expect(next).resolves.toBe("next");
  });
});

describe("errors", () => {
  it("a 401 refreshes once and retries once", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", EXEC);
    fake.state.unauthorizedOnce = 1;
    const res = await h.api.get("PKG", conn, "/me");
    expect(res.status).toBe(200);
    expect(fake.state.refreshes).toBe(1);
    expect(fake.state.graphRequests).toHaveLength(2);
  });

  it("a second 401 is final: failed (forbidden), the fixed message, no reconnect recorded", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", EXEC);
    fake.state.unauthorizedOnce = 2;
    const e = await failure(h.api.get("PKG", conn, "/me"));
    expect(e.info).toMatchObject({ kind: "forbidden", http_status: 401, provider_error_code: "InvalidAuthenticationToken" });
    expect(fake.state.refreshes).toBe(1);
    expect(h.reconnects).toEqual([]);
  });

  it.each([
    [400, "ErrorInvalidIdMalformed", "invalid_input", "disposition_fail"],
    [403, "ErrorAccessDenied", "forbidden", "disposition_fail"],
    [404, "ErrorItemNotFound", "not_found", "disposition_fail"],
    [410, "syncStateNotFound", "not_found", "disposition_fail"],
  ])("%i is failed (%s -> %s) with a fixed message, and the T-196 log keeps only scrubbed fields", async (status, code, kind) => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", EXEC);
    fake.state.meFail = { status, code, times: 1 };
    const e = await failure(h.api.get("PKG", conn, "/me"));
    expect(e.info).toMatchObject({ kind, http_status: status, provider_error_code: code, endpoint: "/me" });
    expect(e.message).toMatch(/^Microsoft /);
    expect(JSON.stringify(e.toJSON())).not.toContain(MICROSOFT_ERROR_TEXT_CANARY);
    expect(h.apiErrors).toHaveLength(1);
    expect(h.apiErrors[0]).toMatchObject({ provider: "microsoft", endpoint: "/me", http_status: status, provider_error_code: code, kind });
    expect(h.apiErrors[0]?.provider_message).toBe(e.message);
    expect(allText(h)).not.toContain(MICROSOFT_ERROR_TEXT_CANARY);
  });

  it("5xx is retried by the shared client, then ends as a transient error", async () => {
    const { h, fake } = setup({ sleep: async () => undefined });
    const { conn } = h.connect("PKG", EXEC);
    fake.state.meFail = { status: 502, code: "ErrorBadGateway", times: 99 };
    const e = await failure(h.api.get("PKG", conn, "/me"));
    expect(e.info).toMatchObject({ kind: "transient", disposition: "retry", http_status: 502 });
    expect(fake.state.graphRequests).toHaveLength(4); // first attempt + 3 retries
    expect(h.apiErrors).toHaveLength(1);
  });

  it("a revoked grant surfaces as reconnect_required from the token manager and is not an API error", async () => {
    const { h, fake } = setup();
    const { conn, account } = h.connect("PKG", EXEC);
    account.revoked = true;
    h.expireStoredAccess(conn.id);
    const e = await failure(h.api.get("PKG", conn, "/me"));
    expect(e.info.kind).toBe("reconnect_required");
    expect(h.reconnects).toHaveLength(1);
    expect(h.apiErrors).toEqual([]);
    expect(fake.state.graphRequests).toHaveLength(0);
  });

  it("a token-endpoint outage passes through unclassified and is not recorded as a Graph API error", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", EXEC);
    h.expireStoredAccess(conn.id);
    fake.state.failRefresh = { status: 401, error: "invalid_client" };
    const e = await failure(h.api.get("PKG", conn, "/me"));
    expect(e.info.kind).toBe("forbidden");
    expect(h.apiErrors).toEqual([]);
  });
});

describe("the token canary", () => {
  it("no access token, refresh token or client secret appears in logs, errors, error records, health results or responses", async () => {
    const { h, fake } = setup({ sleep: async () => undefined });
    const { conn, account } = h.connect("PKG", EXEC);
    const seen: unknown[] = [];
    const secretsToHide = () => [FAKE_GRAPH_CLIENT_SECRET, ...account.accessTokens, ...account.refreshTokens, String(h.storedSet(conn.id)?.access_token), String(h.storedSet(conn.id)?.refresh_token)];

    // a refresh, then a good call, a 401 whose body echoes the bearer token, a Graph failure and a revoked grant
    h.expireStoredAccess(conn.id);
    seen.push(await h.api.get("PKG", conn, "/me"));
    fake.state.unauthorizedOnce = 2;
    seen.push((await failure(h.api.get("PKG", conn, "/me"))).toJSON());
    fake.state.meFail = { status: 404, code: "ErrorItemNotFound", times: 1 };
    seen.push((await failure(h.api.get("PKG", conn, "/me"))).toJSON());
    seen.push(await h.health("PKG", conn));
    account.revoked = true;
    h.expireStoredAccess(conn.id);
    const e = await failure(h.api.get("PKG", conn, "/me"));
    seen.push(e.toJSON(), e.message, String(e.stack));
    seen.push(await h.health("PKG", conn));

    const text = allText(h, seen);
    expect(h.logs.length).toBeGreaterThan(3); // the check is meaningful: things were logged
    expect(account.accessTokens.size).toBeGreaterThan(1);
    for (const s of secretsToHide()) expect(text, s.slice(0, 24)).not.toContain(s);
    expect(text).not.toContain(MICROSOFT_ERROR_TEXT_CANARY);
  });
});
