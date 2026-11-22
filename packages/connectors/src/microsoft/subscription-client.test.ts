// The Graph subscription client (T-068, T-264, spec §14): exactly three method + path templates and an allowed-keys list per route, everything else refused BEFORE the guard and any
// token read; no request is repeated by the HTTP client; a 401 refreshes once; `includeResourceData` can never be sent. Synthetic data only; the fake Graph records what arrives (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createMicrosoftHarness, TENANT_A } from "../testing/microsoft-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { createFakeSubscriptions } from "../testing/msw/microsoft/subscriptions";
import { GRAPH_SUBSCRIPTION_BODY_KEYS, GRAPH_SUBSCRIPTION_ROUTES, createGraphSubscriptionClient, isAllowedGraphSubscription, type GraphSubscriptionRequest } from "./subscription-client";

const fake = createFakeMicrosoft();
const subs = createFakeSubscriptions(fake);
useMockServer(...fake.handlers, ...subs.handlers);
afterEach(() => RateLimiter.resetForTests());

const URL_OK = "https://app.example.test/api/webhooks/microsoft";
const STATE = "synthetic-client-state-0123456789-abcdefghijklmnop";
const create = (over: Record<string, unknown> = {}): GraphSubscriptionRequest => ({
  method: "POST",
  path: "/subscriptions",
  body: {
    changeType: "created,updated,deleted",
    notificationUrl: URL_OK,
    lifecycleNotificationUrl: URL_OK,
    resource: "me/mailfolders('inbox')/messages",
    expirationDateTime: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    clientState: STATE,
    ...over,
  },
});

function setup() {
  subs.reset();
  const h = createMicrosoftHarness({ fake, lanes: { PKG: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: ["pubkgroup.example.test"] } } });
  const made = h.connect("PKG", "sub@pubkgroup.example.test");
  let t = Date.now();
  const client = createGraphSubscriptionClient({ guard: h.guard, tokens: h.tokens, httpOptions: { sleep: async (ms) => void (t += ms), now: () => t } });
  return { h, client, conn: made.conn };
}

describe("the allow-list", () => {
  it("is exactly the three templates of spec §14", () => {
    expect(GRAPH_SUBSCRIPTION_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /subscriptions", "PATCH /subscriptions/{id}", "DELETE /subscriptions/{id}"]);
    expect(Object.keys(GRAPH_SUBSCRIPTION_BODY_KEYS)).toEqual(["POST /subscriptions", "PATCH /subscriptions/{id}", "DELETE /subscriptions/{id}"]);
  });

  it("every other method and path is refused before the guard and before any token read", async () => {
    const { h, client, conn } = setup();
    const forbidden: [string, string][] = [
      ["GET", "/subscriptions"],
      ["GET", "/subscriptions/{id}"],
      ["PUT", "/subscriptions/{id}"],
      ["PATCH", "/subscriptions"],
      ["DELETE", "/subscriptions"],
      ["POST", "/subscriptions/{id}"],
      ["POST", "/subscriptions/{id}/reauthorize"],
      ["POST", "/subscriptions/"],
      ["POST", "/subscriptions?x=1"],
      ["POST", "/subscriptions/%2e%2e/me/messages"],
      ["POST", "/me/subscriptions"],
      ["POST", "/me/messages"],
      ["POST", "/me/sendMail"],
      ["PATCH", "/me/messages/{id}"],
      ["DELETE", "/me/messages/{id}"],
      ["POST", "/users/someone/subscriptions"],
      ["POST", "/$batch"],
      ["POST", "/me/events"],
    ];
    for (const [method, path] of forbidden) {
      expect(isAllowedGraphSubscription(method, path), `${method} ${path}`).toBe(false);
      await expect(client.request("PKG", conn, { method, path, params: path.includes("{id}") ? { id: "x" } : undefined, body: {} } as unknown as GraphSubscriptionRequest), `${method} ${path}`).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    }
    expect(h.stats.tokenReads, "a refused route read a token").toBe(0);
    expect(h.stats.loads, "a refused route reached the guard").toBe(0);
    expect(subs.requests).toHaveLength(0);
    expect(fake.state.graphRequests).toHaveLength(0);
  });

  it("only the allowed body keys: includeResourceData (rich notifications), expirationDateTime on a POST body of another shape, and any other field are refused before any token read", async () => {
    const { h, client, conn } = setup();
    const bad: GraphSubscriptionRequest[] = [
      create({ includeResourceData: true }),
      create({ encryptionCertificate: "x" }),
      create({ latestSupportedTlsVersion: "v1_2" }),
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: "abc" }, body: { expirationDateTime: "2026-12-01T00:00:00Z", notificationUrl: URL_OK } },
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: "abc" }, body: { clientState: STATE } },
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: "abc" }, body: { includeResourceData: true } },
      { method: "DELETE", path: "/subscriptions/{id}", params: { id: "abc" }, body: {} },
      { method: "POST", path: "/subscriptions", body: [] as never },
      { method: "POST", path: "/subscriptions", body: "text" as never },
      { method: "POST", path: "/subscriptions" } as never,
    ];
    for (const r of bad) await expect(client.request("PKG", conn, r), `${r.method} ${r.path}`).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(h.stats.tokenReads).toBe(0);
    expect(h.stats.loads).toBe(0);
    expect(subs.requests).toHaveLength(0);
  });

  it("a path parameter that could move the request, and a missing or extra parameter, are refused before any token read", async () => {
    const { h, client, conn } = setup();
    const body = { expirationDateTime: "2026-12-01T00:00:00Z" };
    const bad: GraphSubscriptionRequest[] = [
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: "a/b" }, body },
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: "a%2fb" }, body },
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: ".." }, body },
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: "a?b=1" }, body },
      { method: "PATCH", path: "/subscriptions/{id}", params: {}, body },
      { method: "DELETE", path: "/subscriptions/{id}", params: { id: "" } },
      { method: "POST", path: "/subscriptions", params: { id: "x" }, body: create().body as never },
    ];
    for (const r of bad) await expect(client.request("PKG", conn, r)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(h.stats.tokenReads).toBe(0);
    expect(subs.requests).toHaveLength(0);
  });

  it("a forged connection, another lane's connection and a Google connection are refused before any token read", async () => {
    const { h, client, conn } = setup();
    await expect(client.request("PKG", { ...conn }, create())).rejects.toBeTruthy();
    await expect(client.request("APK", conn, create())).rejects.toBeTruthy();
    await expect(client.request("PKG", { ...conn, provider: "google" }, create())).rejects.toBeTruthy();
    expect(h.stats.tokenReads).toBe(0);
    expect(subs.requests).toHaveLength(0);
  });
});

describe("sending", () => {
  it("create, renew and stop go out with a bearer token; the fake records them and answers as Graph does", async () => {
    const { client, conn } = setup();
    const made = await client.request<{ id: string }>("PKG", conn, create());
    expect(made.status).toBe(201);
    const id = made.data.id;
    const renewed = await client.request("PKG", conn, { method: "PATCH", path: "/subscriptions/{id}", params: { id }, body: { expirationDateTime: new Date(Date.now() + 5 * 86_400_000).toISOString() } });
    expect(renewed.status).toBe(200);
    const stopped = await client.request("PKG", conn, { method: "DELETE", path: "/subscriptions/{id}", params: { id } });
    expect(stopped.status).toBe(204);
    expect(subs.requests.map((r) => `${r.method} ${r.path.replace(id, "{id}")}`)).toEqual(["POST /v1.0/subscriptions", "PATCH /v1.0/subscriptions/{id}", "DELETE /v1.0/subscriptions/{id}"]);
    expect(subs.sawIncludeResourceData).toBe(0);
  });

  it("a 404 on a renewal or a stop is a not_found error with the status kept (the caller reads it as gone)", async () => {
    const { client, conn } = setup();
    await expect(client.request("PKG", conn, { method: "PATCH", path: "/subscriptions/{id}", params: { id: "no-such-id" }, body: { expirationDateTime: new Date(Date.now() + 86_400_000).toISOString() } })).rejects.toMatchObject({ info: { kind: "not_found", http_status: 404 } });
    await expect(client.request("PKG", conn, { method: "DELETE", path: "/subscriptions/{id}", params: { id: "no-such-id" } })).rejects.toMatchObject({ info: { kind: "not_found", http_status: 404 } });
  });

  it("a 5xx or a 429 on a POST is NOT retried by the client (one request), nor on a PATCH or a DELETE", async () => {
    const { client, conn } = setup();
    subs.failNext("create", 503, 1);
    await expect(client.request("PKG", conn, create())).rejects.toMatchObject({ info: { kind: "transient" } });
    subs.failNext("create", 429, 1);
    await expect(client.request("PKG", conn, create())).rejects.toMatchObject({ info: { kind: "rate_limited" } });
    expect(subs.requests.filter((r) => r.method === "POST")).toHaveLength(2);
    subs.failNext("renew", 503, 1);
    await expect(client.request("PKG", conn, { method: "PATCH", path: "/subscriptions/{id}", params: { id: "x" }, body: { expirationDateTime: new Date(Date.now() + 86_400_000).toISOString() } })).rejects.toMatchObject({ info: { kind: "transient" } });
    subs.failNext("delete", 503, 1);
    await expect(client.request("PKG", conn, { method: "DELETE", path: "/subscriptions/{id}", params: { id: "x" } })).rejects.toMatchObject({ info: { kind: "transient" } });
    expect(subs.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(subs.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("an expired access token is refreshed once and the request goes out once more", async () => {
    const { h, client, conn } = setup();
    h.expireStoredAccess(conn.id);
    const res = await client.request("PKG", conn, create());
    expect(res.status).toBe(201);
    expect(subs.subscriptions.size).toBe(1);
  });

  it("the guard runs first: a lane that no longer enables Microsoft reads no token and sends nothing", async () => {
    const { h, client, conn } = setup();
    h.setLane("PKG", { providers: ["google"], microsoft: null });
    await expect(client.request("PKG", conn, create())).rejects.toMatchObject({ info: { kind: "connection_unavailable" } });
    expect(h.stats.tokenReads).toBe(0);
    expect(subs.requests).toHaveLength(0);
  });

  it("a Graph error never carries Microsoft's text or the token", async () => {
    const { client, conn } = setup();
    subs.failNext("create", 400, 1);
    const e = await client.request("PKG", conn, create()).catch((x: unknown) => x);
    expect(JSON.stringify(e)).not.toContain("canary");
    expect(JSON.stringify(e)).not.toContain(STATE);
  });
});
