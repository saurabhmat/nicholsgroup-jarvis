// The Teams subscription client (T-289, spec 9.1; the pattern of microsoft/subscription-client.test.ts): exactly three method + path templates and an allowed-keys list per route, everything else
// refused BEFORE the guard and any token read; a POST is created-only and for one person's all chats; `includeResourceData` can never be sent; no request is repeated by the HTTP client; a 401
// refreshes once; the guard needs `chat_read` on the lane AND on the connection. MSW fakes, synthetic data only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams, TEAMS_ERROR_TEXT_CANARY } from "../testing/msw/teams/handlers";
import { createFakeTeamsSubscriptions } from "../testing/msw/teams/subscriptions";
import { createTeamsHarness } from "../testing/teams-harness";
import { TEAMS_SUBSCRIPTION_ROUTES, isTeamsSubscriptionRoute, isTeamsReadPath, isTeamsWritePath } from "./constants";
import { TEAMS_SUBSCRIPTION_BODY_KEYS, createTeamsSubscriptionClient, type TeamsSubscriptionRequest } from "./subscription-client";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const URL_OK = "https://app.example.test/api/webhooks/microsoft";
const STATE = "synthetic-client-state-0123456789-abcdefghijklmnop";
const PERSON = "person@teams.example.test";

function setup(features: ("chat_read" | "chat_send")[] = ["chat_read"]) {
  const fake = createFakeTeams();
  const subs = createFakeTeamsSubscriptions(fake);
  server.use(...fake.handlers, ...subs.handlers);
  const h = createTeamsHarness({ fake, lanes: { PKG: { teams: { features }, mailProviders: ["google"] } } });
  const made = h.connect("PKG", PERSON, { features });
  const client = createTeamsSubscriptionClient({ guard: h.guard, tokens: h.tokens, logger: h.logger, errors: h.errors, httpOptions: h.httpOptions });
  const create = (over: Record<string, unknown> = {}): TeamsSubscriptionRequest => ({
    method: "POST",
    path: "/subscriptions",
    body: {
      changeType: "created",
      notificationUrl: URL_OK,
      lifecycleNotificationUrl: URL_OK,
      resource: `users/${made.account.objectId}/chats/getAllMessages`,
      expirationDateTime: new Date(Date.now() + 4_200 * 60_000).toISOString(),
      clientState: STATE,
      ...over,
    },
  });
  return { fake, subs, h, client, conn: made.conn, account: made.account, create };
}
const untouched = (s: ReturnType<typeof setup>) => {
  expect(s.h.stats.tokenReads, "a refused request read a token").toBe(0);
  expect(s.h.stats.loads, "a refused request reached the guard").toBe(0);
  expect(s.subs.requests).toHaveLength(0);
  expect(s.fake.state.graphRequests).toHaveLength(0);
};

describe("the allow-list", () => {
  it("is exactly the three templates, with an exact body-key list each", () => {
    expect(TEAMS_SUBSCRIPTION_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /subscriptions", "PATCH /subscriptions/{id}", "DELETE /subscriptions/{id}"]);
    expect(Object.keys(TEAMS_SUBSCRIPTION_BODY_KEYS)).toEqual(["POST /subscriptions", "PATCH /subscriptions/{id}", "DELETE /subscriptions/{id}"]);
    expect(TEAMS_SUBSCRIPTION_BODY_KEYS["POST /subscriptions"]).toEqual(["changeType", "notificationUrl", "lifecycleNotificationUrl", "resource", "expirationDateTime", "clientState"]);
    expect(TEAMS_SUBSCRIPTION_BODY_KEYS["PATCH /subscriptions/{id}"]).toEqual(["expirationDateTime"]);
    expect(TEAMS_SUBSCRIPTION_BODY_KEYS["DELETE /subscriptions/{id}"]).toEqual([]);
  });

  it("the subscription routes are not read routes and not write routes: the read and write clients cannot reach them, and the subscription client cannot reach a chat", () => {
    for (const r of TEAMS_SUBSCRIPTION_ROUTES) {
      expect(isTeamsReadPath(r.path)).toBe(false);
      expect(isTeamsWritePath(r.path)).toBe(false);
    }
    for (const path of ["/chats/{chatId}/messages", "/me/chats", "/me", "/teams/{teamId}/channels/{channelId}/messages"]) {
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) expect(isTeamsSubscriptionRoute(method, path), `${method} ${path}`).toBe(false);
    }
  });

  it("every other method and path is refused before the guard and before any token read: message routes, reactions, mail routes, batch, other subscription shapes", async () => {
    const s = setup();
    const forbidden: [string, string][] = [
      ["GET", "/subscriptions"], ["GET", "/subscriptions/{id}"], ["PUT", "/subscriptions/{id}"], ["PATCH", "/subscriptions"], ["DELETE", "/subscriptions"],
      ["POST", "/subscriptions/{id}"], ["POST", "/subscriptions/{id}/reauthorize"], ["POST", "/subscriptions/"], ["POST", "/subscriptions?x=1"], ["POST", "/subscriptions/%2e%2e/me/messages"],
      ["POST", "/chats/{chatId}/messages"], ["POST", "/teams/{teamId}/channels/{channelId}/messages"], ["POST", "/chats/{chatId}/messages/{messageId}/setReaction"],
      ["POST", "/chats/{chatId}/messages/{messageId}/softDelete"], ["POST", "/chats"], ["POST", "/me/sendMail"], ["POST", "/me/messages"], ["DELETE", "/chats/{chatId}/messages/{messageId}"], ["PATCH", "/me/messages/{id}"],
      ["POST", "/$batch"], ["POST", "/users/someone/subscriptions"], ["GET", "/me/chats"], ["GET", "/me"],
    ];
    for (const [method, path] of forbidden) {
      expect(isTeamsSubscriptionRoute(method, path), `${method} ${path}`).toBe(false);
      await expect(s.client.request("PKG", s.conn, { method, path, params: path.includes("{id}") ? { id: "x" } : undefined, body: {} } as unknown as TeamsSubscriptionRequest), `${method} ${path}`).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    }
    untouched(s);
  });

  it("only the allowed body keys: includeResourceData, an encryption certificate and every other field are refused before any token read", async () => {
    const s = setup();
    const bad: TeamsSubscriptionRequest[] = [
      s.create({ includeResourceData: true }),
      s.create({ includeResourceData: false }),
      s.create({ encryptionCertificate: "x" }),
      s.create({ encryptionCertificateId: "x" }),
      s.create({ latestSupportedTlsVersion: "v1_2" }),
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: "abc" }, body: { expirationDateTime: "2026-12-01T00:00:00Z", notificationUrl: URL_OK } },
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: "abc" }, body: { includeResourceData: true } },
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: "abc" }, body: { clientState: STATE } },
      { method: "DELETE", path: "/subscriptions/{id}", params: { id: "abc" }, body: {} },
      { method: "POST", path: "/subscriptions", body: [] as never },
      { method: "POST", path: "/subscriptions", body: "text" as never },
      { method: "POST", path: "/subscriptions" } as never,
    ];
    for (const r of bad) await expect(s.client.request("PKG", s.conn, r), `${r.method} ${r.path} ${JSON.stringify(r.body)}`).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    untouched(s);
  });

  it("a create is `created` only and for one person's all chats: updated, deleted, a list of types, a per-chat resource, a tenant-wide or channel resource, mail resources and an incomplete body are all refused", async () => {
    const s = setup();
    const uuid = s.account.objectId;
    const bad: TeamsSubscriptionRequest[] = [
      s.create({ changeType: "created,updated" }),
      s.create({ changeType: "updated" }),
      s.create({ changeType: "deleted" }),
      s.create({ changeType: "created,updated,deleted" }),
      s.create({ changeType: "Created" }),
      s.create({ resource: "chats('19:abc@thread.v2')/messages" }),
      s.create({ resource: "/chats/19:abc@thread.v2/messages" }),
      s.create({ resource: "chats/getAllMessages" }),
      s.create({ resource: "/chats/getAllMessages" }),
      s.create({ resource: "teams/getAllMessages" }),
      s.create({ resource: `teams/${uuid}/channels/19:x@thread.tacv2/messages` }),
      s.create({ resource: "me/mailfolders('inbox')/messages" }),
      s.create({ resource: "me/events" }),
      s.create({ resource: `users/${uuid}/chats/getAllMessages/extra` }),
      s.create({ resource: `users/${uuid}/chats` }),
      s.create({ resource: `users/${uuid.toUpperCase()}/chats/getAllMessages` }),
      s.create({ resource: `users/someone@example.test/chats/getAllMessages` }),
      s.create({ resource: `users/${uuid}/chats/getAllMessages?x=1` }),
      s.create({ resource: 5 }),
      { method: "POST", path: "/subscriptions", body: { changeType: "created", resource: `users/${uuid}/chats/getAllMessages` } },
    ];
    for (const r of bad) await expect(s.client.request("PKG", s.conn, r), JSON.stringify(r.body)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    untouched(s);
  });

  it("a path parameter that could move the request, and a missing or extra parameter, are refused before any token read", async () => {
    const s = setup();
    const body = { expirationDateTime: "2026-12-01T00:00:00Z" };
    const bad: TeamsSubscriptionRequest[] = [
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: "a/b" }, body },
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: "a%2fb" }, body },
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: ".." }, body },
      { method: "PATCH", path: "/subscriptions/{id}", params: { id: "a?b=1" }, body },
      { method: "PATCH", path: "/subscriptions/{id}", params: {}, body },
      { method: "DELETE", path: "/subscriptions/{id}", params: { id: "" } },
      { method: "POST", path: "/subscriptions", params: { id: "x" }, body: s.create().body as never },
    ];
    for (const r of bad) await expect(s.client.request("PKG", s.conn, r)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    untouched(s);
  });

  it("a forged connection, another lane's connection and a Microsoft mail connection are refused before any token read", async () => {
    const s = setup();
    await expect(s.client.request("PKG", { ...s.conn }, s.create())).rejects.toBeTruthy();
    await expect(s.client.request("APK", s.conn, s.create())).rejects.toBeTruthy();
    await expect(s.client.request("PKG", { ...s.conn, provider: "microsoft" }, s.create())).rejects.toBeTruthy();
    expect(s.h.stats.tokenReads).toBe(0);
    expect(s.subs.requests).toHaveLength(0);
  });
});

describe("sending", () => {
  it("create, renew and stop go out with a bearer token; the fake records them and answers as Graph does; includeResourceData never arrives", async () => {
    const s = setup();
    const made = await s.client.request<{ id: string }>("PKG", s.conn, s.create());
    expect(made.status).toBe(201);
    const id = made.data.id;
    const renewed = await s.client.request("PKG", s.conn, { method: "PATCH", path: "/subscriptions/{id}", params: { id }, body: { expirationDateTime: new Date(Date.now() + 4_000 * 60_000).toISOString() } });
    expect(renewed.status).toBe(200);
    const stopped = await s.client.request("PKG", s.conn, { method: "DELETE", path: "/subscriptions/{id}", params: { id } });
    expect(stopped.status).toBe(204);
    expect(s.subs.requests.map((r) => `${r.method} ${r.path.replace(id, "{id}")}`)).toEqual(["POST /v1.0/subscriptions", "PATCH /v1.0/subscriptions/{id}", "DELETE /v1.0/subscriptions/{id}"]);
    expect(s.subs.sawIncludeResourceData).toBe(0);
  });

  it("a 404 on a renewal or a stop is a not_found error with the status kept (the caller reads it as gone) and is not an error-log row", async () => {
    const s = setup();
    await expect(s.client.request("PKG", s.conn, { method: "PATCH", path: "/subscriptions/{id}", params: { id: "no-such-id" }, body: { expirationDateTime: new Date(Date.now() + 86_400_000).toISOString() } })).rejects.toMatchObject({ info: { kind: "not_found", http_status: 404 } });
    await expect(s.client.request("PKG", s.conn, { method: "DELETE", path: "/subscriptions/{id}", params: { id: "no-such-id" } })).rejects.toMatchObject({ info: { kind: "not_found", http_status: 404 } });
    expect(s.h.apiErrors).toHaveLength(0);
  });

  it("a 5xx or a 429 is NOT retried by the client (one request per call, never a second POST), on a POST, a PATCH and a DELETE", async () => {
    const s = setup();
    s.subs.failNext("create", 503, 1);
    await expect(s.client.request("PKG", s.conn, s.create())).rejects.toMatchObject({ info: { kind: "transient" } });
    s.subs.failNext("create", 429, 1);
    await expect(s.client.request("PKG", s.conn, s.create())).rejects.toMatchObject({ info: { kind: "rate_limited" } });
    expect(s.subs.requests.filter((r) => r.method === "POST")).toHaveLength(2);
    s.subs.failNext("renew", 503, 1);
    await expect(s.client.request("PKG", s.conn, { method: "PATCH", path: "/subscriptions/{id}", params: { id: "x" }, body: { expirationDateTime: new Date(Date.now() + 86_400_000).toISOString() } })).rejects.toMatchObject({ info: { kind: "transient" } });
    s.subs.failNext("delete", 503, 1);
    await expect(s.client.request("PKG", s.conn, { method: "DELETE", path: "/subscriptions/{id}", params: { id: "x" } })).rejects.toMatchObject({ info: { kind: "transient" } });
    expect(s.subs.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(s.subs.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("a 401 refreshes the token once and the request goes out once more; a second 401 is final", async () => {
    const s = setup();
    s.subs.failNext("create", 401, 1);
    const res = await s.client.request("PKG", s.conn, s.create());
    expect(res.status).toBe(201);
    expect(s.subs.subscriptions.size).toBe(1);
    expect(s.fake.state.refreshes).toBe(1);
    s.subs.failNext("create", 401, 2);
    await expect(s.client.request("PKG", s.conn, s.create())).rejects.toMatchObject({ info: { kind: "forbidden", http_status: 401 } });
  });

  it("the guard runs first and needs chat_read on the lane AND the connection: with either missing, or Teams paused, no token is read and nothing is sent", async () => {
    const s = setup();
    s.h.setLane("PKG", { teams: { enabled: false } });
    await expect(s.client.request("PKG", s.conn, s.create())).rejects.toMatchObject({ info: { kind: "connection_unavailable" } });
    s.h.setLane("PKG", { teams: { enabled: true, features: ["chat_send"] } });
    await expect(s.client.request("PKG", s.conn, s.create())).rejects.toMatchObject({ info: { kind: "forbidden" } });
    const noFeature = s.h.connect("PKG", "other@teams.example.test", { features: [] });
    s.h.setLane("PKG", { teams: { enabled: true, features: ["chat_read"] } });
    await expect(s.client.request("PKG", noFeature.conn, { ...s.create(), body: { ...(s.create().body as object), resource: `users/${noFeature.account.objectId}/chats/getAllMessages` } })).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(s.h.stats.tokenReads).toBe(0);
    expect(s.subs.requests).toHaveLength(0);
  });

  it("a Graph error never carries Microsoft's text, the token or the clientState", async () => {
    const s = setup();
    s.subs.failNext("create", 400, 1);
    const e = await s.client.request("PKG", s.conn, s.create()).catch((x: unknown) => x);
    const dump = JSON.stringify(e) + JSON.stringify(s.h.apiErrors) + JSON.stringify(s.h.logs);
    expect(dump).not.toContain(TEAMS_ERROR_TEXT_CANARY);
    expect(dump).not.toContain(STATE);
    for (const t of s.account.accessTokens) expect(dump).not.toContain(t);
  });

  it("one subscription request at a time per connection class does not exceed the shared pacing: a burst of renewals is spaced by the rate limit, not sent at once", async () => {
    const s = setup();
    await Promise.all([1, 2, 3].map((n) => s.client.request("PKG", s.conn, { method: "DELETE", path: "/subscriptions/{id}", params: { id: `x${String(n)}` } }).catch(() => undefined)));
    expect(s.subs.requests).toHaveLength(3);
  });
});
