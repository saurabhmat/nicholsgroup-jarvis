// The Graph write client (T-262, spec §10, §17 test 22): exactly four method + path templates; everything else is refused BEFORE the guard and any token read; a POST
// or PATCH is never repeated by the HTTP client; a 401 refreshes once. Synthetic data only; the fake Graph records what arrives (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createMicrosoftHarness, TENANT_A } from "../testing/microsoft-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { createFakeMailWrite } from "../testing/msw/microsoft/mail-write";
import { GRAPH_WRITE_ROUTES, createGraphWriteClient, isAllowedGraphWrite, type GraphWriteRequest } from "./write-client";

const fake = createFakeMicrosoft();
const write = createFakeMailWrite(fake);
useMockServer(...fake.handlers, ...write.handlers);
afterEach(() => RateLimiter.resetForTests());

function setup() {
  write.reset();
  const h = createMicrosoftHarness({ fake, lanes: { PKG: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: ["pubkgroup.example.test"] } } });
  const made = h.connect("PKG", "writer@pubkgroup.example.test");
  let t = Date.now();
  const client = createGraphWriteClient({ guard: h.guard, tokens: h.tokens, httpOptions: { sleep: async (ms) => void (t += ms), now: () => t } });
  return { h, client, conn: made.conn, account: made.account };
}

describe("the allow-list (spec §17 test 22)", () => {
  it("is exactly the four templates of spec §10", () => {
    expect(GRAPH_WRITE_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /me/messages", "POST /me/messages/{id}/createReply", "PATCH /me/messages/{id}", "POST /me/messages/{id}/send"]);
  });

  it("every DELETE, move, copy, forward, rules, settings, attachment and sendMail request is refused before the guard and before any token read", async () => {
    const { h, client, conn } = setup();
    const forbidden: [string, string][] = [
      ["DELETE", "/me/messages/{id}"],
      ["DELETE", "/me/messages"],
      ["POST", "/me/messages/{id}/move"],
      ["POST", "/me/messages/{id}/copy"],
      ["POST", "/me/messages/{id}/forward"],
      ["POST", "/me/messages/{id}/createForward"],
      ["POST", "/me/messages/{id}/replyAll"],
      ["POST", "/me/messages/{id}/reply"],
      ["POST", "/me/messages/{id}/createReplyAll"],
      ["POST", "/me/sendMail"],
      ["POST", "/me/messages/{id}/attachments"],
      ["POST", "/me/mailFolders"],
      ["PATCH", "/me/mailFolders/{id}"],
      ["DELETE", "/me/mailFolders/{id}"],
      ["POST", "/me/mailFolders/{id}/messages/{id}/move"],
      ["POST", "/me/mailFolders/inbox/messageRules"],
      ["PATCH", "/me/mailboxSettings"],
      ["PATCH", "/me/messages"],
      ["PUT", "/me/messages/{id}"],
      ["POST", "/me/messages/{id}/send/"],
      ["POST", "/me/messages/{id}/createReply?x=1"],
      ["POST", "/users/someone/messages"],
      ["POST", "/me/events"],
      ["POST", "/me/messages/{id}/%2e%2e/send"],
    ];
    for (const [method, path] of forbidden) {
      expect(isAllowedGraphWrite(method, path), `${method} ${path}`).toBe(false);
      await expect(client.request("PKG", conn, { method, path, params: path.includes("{id}") ? { id: "x" } : undefined, body: {} } as unknown as GraphWriteRequest), `${method} ${path}`).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    }
    expect(h.stats.tokenReads, "a refused route read a token").toBe(0);
    expect(h.stats.loads, "a refused route reached the guard").toBe(0);
    expect(fake.state.graphRequests).toHaveLength(0);
    expect(write.requests).toHaveLength(0);
  });

  it("a path parameter that could move the request, a missing or extra parameter, and a non-object body are refused before any token read", async () => {
    const { h, client, conn } = setup();
    const bad: GraphWriteRequest[] = [
      { method: "POST", path: "/me/messages/{id}/send", params: { id: "a/b" }, body: {} },
      { method: "POST", path: "/me/messages/{id}/send", params: { id: "a%2fb" }, body: {} },
      { method: "POST", path: "/me/messages/{id}/send", params: { id: ".." }, body: {} },
      { method: "POST", path: "/me/messages/{id}/send", params: {}, body: {} },
      { method: "POST", path: "/me/messages", params: { id: "x" }, body: {} },
      { method: "POST", path: "/me/messages", body: [] as never },
      { method: "POST", path: "/me/messages", body: "text" as never },
    ];
    for (const r of bad) await expect(client.request("PKG", conn, r)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(h.stats.tokenReads).toBe(0);
    expect(write.requests).toHaveLength(0);
  });

  it("only the allowed body keys per route: attachments, from, replyTo, isRead and any other field are refused before any token read; createReply and send take an empty object only", async () => {
    const { h, client, conn } = setup();
    const id = { id: "AAMkD1=" };
    const bad: GraphWriteRequest[] = [
      { method: "POST", path: "/me/messages", body: { subject: "x", attachments: [{ name: "a" }] } },
      { method: "POST", path: "/me/messages", body: { from: { emailAddress: { address: "x@y.test" } } } },
      { method: "POST", path: "/me/messages", body: { replyTo: [{ emailAddress: { address: "x@y.test" } }] } },
      { method: "PATCH", path: "/me/messages/{id}", params: id, body: { isRead: true } },
      { method: "PATCH", path: "/me/messages/{id}", params: id, body: { attachments: [] } },
      { method: "PATCH", path: "/me/messages/{id}", params: id, body: { replyTo: [] } },
      { method: "PATCH", path: "/me/messages/{id}", params: id, body: { internetMessageHeaders: [] } }, // headers only at create
      { method: "POST", path: "/me/messages/{id}/createReply", params: id, body: { comment: "x" } },
      { method: "POST", path: "/me/messages/{id}/createReply", params: id, body: { message: { body: {} } } },
      { method: "POST", path: "/me/messages/{id}/send", params: id, body: { subject: "x" } },
    ];
    for (const r of bad) await expect(client.request("PKG", conn, r), `${r.method} ${r.path} ${JSON.stringify(Object.keys(r.body))}`).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(h.stats.tokenReads).toBe(0);
    expect(h.stats.loads).toBe(0);
    expect(write.requests).toHaveLength(0);
  });

  it("a forged connection, another lane's connection and a Google connection are refused before any token read", async () => {
    const { h, client, conn } = setup();
    await expect(client.request("PKG", { ...conn }, { method: "POST", path: "/me/messages", body: {} })).rejects.toBeTruthy();
    await expect(client.request("APK", conn, { method: "POST", path: "/me/messages", body: {} })).rejects.toBeTruthy();
    await expect(client.request("PKG", { ...conn, provider: "google" }, { method: "POST", path: "/me/messages", body: {} })).rejects.toBeTruthy();
    expect(h.stats.tokenReads).toBe(0);
    expect(write.requests).toHaveLength(0);
  });
});

describe("sending", () => {
  it("an allowed request goes out with the ImmutableId preference and a bearer token; the 202 of a send has an empty body", async () => {
    const { client, conn, account } = setup();
    write.seed(account, { id: "AAMkD1=", conversationId: "c", folder: "drafts", isDraft: true });
    const res = await client.request("PKG", conn, { method: "POST", path: "/me/messages/{id}/send", params: { id: "AAMkD1=" }, body: {} });
    expect(res.status).toBe(202);
    expect(write.requests[0]).toMatchObject({ method: "POST", hadAuthorization: true, prefer: 'IdType="ImmutableId"' });
  });

  it("a 5xx on a POST is NOT retried by the client (one request)", async () => {
    const { client, conn } = setup();
    write.failNext("create", 503, 5);
    await expect(client.request("PKG", conn, { method: "POST", path: "/me/messages", body: { subject: "x" } })).rejects.toMatchObject({ info: { kind: "transient" } });
    expect(write.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("a 429 on a POST is not retried either (the caller decides); a PATCH 5xx is not retried", async () => {
    const { client, conn, account } = setup();
    write.failNext("create", 429, 5);
    await expect(client.request("PKG", conn, { method: "POST", path: "/me/messages", body: {} })).rejects.toMatchObject({ info: { kind: "rate_limited" } });
    expect(write.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    write.seed(account, { id: "AAMkD2=", conversationId: "c", folder: "drafts", isDraft: true });
    write.failNext("patch", 503, 5);
    await expect(client.request("PKG", conn, { method: "PATCH", path: "/me/messages/{id}", params: { id: "AAMkD2=" }, body: { subject: "y" } })).rejects.toMatchObject({ info: { kind: "transient" } });
    expect(write.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  it("an expired access token is refreshed once and the request goes out once more (a 401 means it was not processed)", async () => {
    const { h, client, conn } = setup();
    h.expireStoredAccess(conn.id);
    const res = await client.request("PKG", conn, { method: "POST", path: "/me/messages", body: { subject: "ok" } });
    expect(res.status).toBe(201);
    expect(write.counts.created).toBe(1);
  });

  it("the guard runs first: a lane that no longer enables Microsoft reads no token and sends nothing", async () => {
    const { h, client, conn } = setup();
    h.setLane("PKG", { providers: ["google"], microsoft: null });
    await expect(client.request("PKG", conn, { method: "POST", path: "/me/messages", body: {} })).rejects.toMatchObject({ info: { kind: "connection_unavailable" } });
    expect(h.stats.tokenReads).toBe(0);
    expect(write.requests).toHaveLength(0);
  });
});
