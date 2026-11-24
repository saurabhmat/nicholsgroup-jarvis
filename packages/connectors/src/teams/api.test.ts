// The Teams Graph READ client (T-279, spec 6): exact path templates, ids validated before any request, a named actor on every call, the guard inside the slot, the token per attempt,
// one refresh on a 401, Retry-After honoured, our own pacing, fixed error messages (never Microsoft's text), and "refused before a token is read" for everything not allowed.
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams, TEAMS_ERROR_TEXT_CANARY } from "../testing/msw/teams/handlers";
import { createTeamsHarness, TEAMS_OTHER_USER, TEAMS_OWNER, type TeamsLaneSetup } from "../testing/teams-harness";
import { TEAMS_READ_ROUTES, TEAMS_WRITE_ROUTES } from "./constants";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const DOMAIN = "teams.example.test";
const PERSON = `person@${DOMAIN}`;
const CHAT = "19:abc123def456@thread.v2";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const user = { kind: "user", userId: TEAMS_OWNER } as const;

function setup(lane: Partial<TeamsLaneSetup> = {}) {
  const fake = createFakeTeams();
  server.use(...fake.handlers);
  const h = createTeamsHarness({ fake, lanes: { PKG: { teams: { features: ["chat_read", "call_links", "channels_read"] }, mailProviders: ["google"], ...lane } } });
  return { fake, h };
}
const rejects = async (p: Promise<unknown>, kind: string, message?: RegExp) => {
  const e = await p.then(() => null, (x: unknown) => x as { info: { kind: string; message: string } });
  expect(e, "expected a refusal").not.toBeNull();
  expect(e?.info.kind).toBe(kind);
  if (message) expect(e?.info.message).toMatch(message);
};
/** Nothing was read from the Vault, nothing was sent to the fake. */
const untouched = (h: ReturnType<typeof setup>["h"], fake: ReturnType<typeof setup>["fake"]) => {
  expect(h.stats.tokenReads).toBe(0);
  expect(fake.state.tokenRequests).toHaveLength(0);
  expect(fake.state.graphRequests).toHaveLength(0);
};

describe("raw bytes (T-285)", () => {
  const HOSTED = "/chats/{chatId}/messages/{messageId}/hostedContents/{hostedId}/$value";
  const hosted = { chatId: CHAT, messageId: "1700000000123", hostedId: "aWQ9" };

  it("only a hosted-content template may be read as bytes, and only with a sane size limit: anything else is refused before a token is read", async () => {
    const { fake, h } = setup();
    const base = { actor: user, retry: false } as const;
    const conn = h.connect("PKG", PERSON).conn;
    await rejects(h.api.get("PKG", conn, { ...base, path: "/me/chats", responseType: "bytes", maxBytes: 4096 }), "invalid_input", /hosted content/);
    await rejects(h.api.get("PKG", conn, { ...base, path: HOSTED, params: hosted, responseType: "bytes" }), "invalid_input", /size limit/);
    await rejects(h.api.get("PKG", conn, { ...base, path: HOSTED, params: hosted, responseType: "bytes", maxBytes: 9 * 1024 * 1024 }), "invalid_input", /size limit/);
    await rejects(h.api.get("PKG", conn, { ...base, path: HOSTED, params: hosted, responseType: "bytes", maxBytes: 10 }), "invalid_input", /size limit/);
    await rejects(h.api.get("PKG", conn, { ...base, path: "/me/chats", maxBytes: 4096 }), "invalid_input", /size limit/);
    await rejects(h.api.get("PKG", conn, { ...base, path: HOSTED, params: hosted, responseType: "text" as never, maxBytes: 4096 }), "invalid_input");
    expect(h.stats.tokenReads).toBe(0);
    expect(fake.state.graphRequests).toHaveLength(0);
  });
});

describe("the read allow-list", () => {
  it("is exactly the spec's thirteen templates, each with the feature it needs; the write list is exactly the three send templates", () => {
    expect(Object.keys(TEAMS_READ_ROUTES).sort()).toEqual(
      [
        "/me",
        "/me/chats",
        "/chats/{chatId}",
        "/chats/{chatId}/members",
        "/chats/{chatId}/messages",
        "/chats/{chatId}/messages/{messageId}",
        "/chats/{chatId}/messages/{messageId}/hostedContents/{hostedId}/$value",
        "/users/{userId}",
        "/me/joinedTeams",
        "/teams/{teamId}/channels",
        "/teams/{teamId}/channels/{channelId}/messages",
        "/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies",
        "/teams/{teamId}/channels/{channelId}/messages/{messageId}/hostedContents/{hostedId}/$value",
      ].sort(),
    );
    expect(Object.keys(TEAMS_WRITE_ROUTES).sort()).toEqual(["/chats/{chatId}/messages", "/teams/{teamId}/channels/{channelId}/messages", "/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies"].sort());
    // a write template is never a read template with the same method semantics: the read client has no way to name a write
    expect(Object.keys(TEAMS_READ_ROUTES).filter((r) => r.includes("/replies") && r.endsWith("/messages"))).toEqual([]);
  });

  it("anything not on the list is refused before the slot, the guard and any token read: another path, a query smuggled into the path, a mail path, dot segments, encoded separators", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", PERSON);
    const paths = [
      "/me/messages", "/me/mailFolders", "/me/events", "/chats", "/me/chats/getAllMessages", "/subscriptions", "/me/chats?$top=1", "/me/../users", "/chats/{chatId}/markChatReadForUser",
      "/chats/{chatId}/messages/{messageId}/replies", "/teams/{teamId}", "/me/presence", "https://evil.example.test/me", "//me", "/ME", "/me/", "",
    ];
    for (const path of paths) await rejects(h.api.get("PKG", conn, { path, actor: user }), "invalid_input", /not allowed|parameters are not valid/);
    untouched(h, fake);
    expect(h.stats.teamsSettingsReads).toBe(0);
  });

  it("ids are validated against their format before any request (no separator, escape, dot segment, wrong shape)", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", PERSON);
    const bad: [string, Record<string, string>][] = [
      ["/chats/{chatId}/messages", { chatId: "../users" }],
      ["/chats/{chatId}/messages", { chatId: "19:x/../../me" }],
      ["/chats/{chatId}/messages", { chatId: "19:x%2f..%2fme" }],
      ["/chats/{chatId}/messages", { chatId: "abc" }],
      ["/chats/{chatId}/messages", { chatId: `19:${"a".repeat(300)}` }],
      ["/chats/{chatId}/messages", { chatId: "" }],
      ["/chats/{chatId}/messages/{messageId}", { chatId: CHAT, messageId: "a/b" }],
      ["/chats/{chatId}/messages/{messageId}", { chatId: CHAT, messageId: ".." }],
      ["/users/{userId}", { userId: "not-a-uuid" }],
      ["/users/{userId}", { userId: USER.toUpperCase() }],
      ["/teams/{teamId}/channels", { teamId: "19:x" }],
    ];
    for (const [path, params] of bad) await rejects(h.api.get("PKG", conn, { path, params, actor: user, query: path === "/users/{userId}" ? { $select: "userPrincipalName" } : undefined }), "invalid_input");
    // wrong parameter sets
    await rejects(h.api.get("PKG", conn, { path: "/chats/{chatId}/messages", actor: user }), "invalid_input");
    await rejects(h.api.get("PKG", conn, { path: "/chats/{chatId}/messages", params: { chatId: CHAT, extra: "x" }, actor: user }), "invalid_input");
    await rejects(h.api.get("PKG", conn, { path: "/me", params: { chatId: CHAT }, actor: user }), "invalid_input");
    untouched(h, fake);
  });

  it("GET /users/{userId} may ask only for the sign-in name", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", PERSON);
    for (const query of [undefined, { $select: "mail" }, { $select: "userPrincipalName,mail" }, { $select: "userPrincipalName", $top: 1 }]) {
      await rejects(h.api.get("PKG", conn, { path: "/users/{userId}", params: { userId: USER }, query, actor: user }), "invalid_input");
    }
    untouched(h, fake);
    const ok = await h.api.get<{ userPrincipalName: string }>("PKG", conn, { path: "/users/{userId}", params: { userId: USER }, query: { $select: "userPrincipalName" }, actor: user });
    expect(ok.data.userPrincipalName).toContain("@");
  });

  it("an actor is required; a job (service actor) may read `/me` only; a malformed user id is refused", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", PERSON);
    await rejects(h.api.get("PKG", conn, { path: "/me/chats" } as never), "invalid_input");
    await rejects(h.api.get("PKG", conn, { path: "/me/chats", actor: { kind: "service" } }), "invalid_input");
    await rejects(h.api.get("PKG", conn, { path: "/me/chats", actor: { kind: "user", userId: "nope" } }), "invalid_input");
    untouched(h, fake);
    await h.api.get("PKG", conn, { path: "/me", query: { $select: "id" }, actor: { kind: "service" } });
  });
});

describe("a read", () => {
  it("goes out with the stored token, the guard having decided first; the request carries the template path and the query, nothing else", async () => {
    const { h, fake } = setup();
    const { conn, account } = h.connect("PKG", PERSON);
    const res = await h.api.get<{ value: unknown[] }>("PKG", conn, { path: "/me/chats", query: { $top: 50 }, actor: user });
    expect(res.data.value).toEqual([]);
    const req = fake.state.graphRequests[0];
    expect(req).toMatchObject({ method: "GET", path: "/v1.0/me/chats", search: "?%24top=50" });
    expect(req?.authorization).toBe(`Bearer ${[...account.accessTokens][0]}`);
    expect(h.stats.teamsSettingsReads).toBeGreaterThan(0);
  });

  it("another person's connection, a lane that does not list the feature, or a connection without it: refused before any token read", async () => {
    const { h, fake } = setup({ teams: { features: ["chat_read"] } });
    const { conn } = h.connect("PKG", PERSON, { owner: TEAMS_OWNER, features: ["chat_read", "channels_read"] });
    await rejects(h.api.get("PKG", conn, { path: "/me/chats", actor: { kind: "user", userId: TEAMS_OTHER_USER } }), "not_found");
    await rejects(h.api.get("PKG", conn, { path: "/me/joinedTeams", actor: user }), "forbidden"); // the lane does not list channels_read
    const lane2 = setup({ teams: { features: ["chat_read", "channels_read"] } });
    const c2 = lane2.h.connect("PKG", PERSON, { features: ["chat_read"] });
    await rejects(lane2.h.api.get("PKG", c2.conn, { path: "/me/joinedTeams", actor: user }), "forbidden"); // the connection lacks it
    untouched(h, fake);
    untouched(lane2.h, lane2.fake);
  });

  it("a stored access token that is close to expiry is refreshed with the Teams app's credentials, and the rotated set replaces the old one", async () => {
    const { h, fake } = setup();
    const { conn, row } = h.connect("PKG", PERSON, { storedAccessExpired: true });
    const before = h.secrets.get(row.id);
    await h.api.get("PKG", conn, { path: "/me", query: { $select: "id" }, actor: { kind: "service" } });
    expect(fake.state.refreshes).toBe(1);
    expect(fake.state.tokenRequests[0]?.fields).toMatchObject({ grant_type: "refresh_token", client_id: "synthetic-teams-client-id-7741" });
    expect(h.secrets.get(row.id)).not.toBe(before);
    expect(h.stats.rotations).toBe(1);
  });

  it("a 401 refreshes once and retries once; a second 401 is final and carries no Microsoft text or token", async () => {
    const { h, fake } = setup();
    const { conn, account } = h.connect("PKG", PERSON);
    fake.state.unauthorizedOnce = 1;
    await h.api.get("PKG", conn, { path: "/me/chats", actor: user });
    expect(fake.state.refreshes).toBe(1);
    expect(fake.state.graphRequests).toHaveLength(2);
    fake.state.unauthorizedOnce = 2;
    const e = await h.api.get("PKG", conn, { path: "/me/chats", actor: user }).then(() => null, (x: unknown) => x as { info: { kind: string; message: string }; message: string });
    expect(e?.info.kind).toBe("forbidden");
    const text = JSON.stringify([e, h.logs, h.apiErrors]);
    expect(text).not.toContain(TEAMS_ERROR_TEXT_CANARY);
    for (const t of account.accessTokens) expect(text).not.toContain(t);
  });

  it("429 with Retry-After is honoured by the shared client and then succeeds; a persistent failure is a fixed message and is recorded once, scrubbed", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", PERSON);
    fake.state.graphFail = { status: 429, code: "TooManyRequests", times: 1, retryAfter: 2 };
    await h.api.get("PKG", conn, { path: "/me/chats", actor: user });
    expect(h.clock.waits.some((w) => w >= 2000)).toBe(true);
    fake.state.graphFail = { status: 403, code: "Forbidden", times: 1 };
    const e = await h.api.get("PKG", conn, { path: "/chats/{chatId}/messages", params: { chatId: CHAT }, actor: user }).then(() => null, (x: unknown) => x as { info: { kind: string; message: string } });
    expect(e?.info.kind).toBe("forbidden");
    expect(JSON.stringify(e)).not.toContain(TEAMS_ERROR_TEXT_CANARY);
    expect(h.apiErrors).toHaveLength(1);
    expect(JSON.stringify(h.apiErrors)).not.toContain(TEAMS_ERROR_TEXT_CANARY);
  });

  it("our own pacing: /me/chats is limited to one request per second per connection and the chat messages to one per second per chat", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", PERSON);
    await h.api.get("PKG", conn, { path: "/me/chats", actor: user });
    const waits = h.clock.waits.length;
    await h.api.get("PKG", conn, { path: "/me/chats", actor: user });
    expect(h.clock.waits.length).toBeGreaterThan(waits); // the second call waited for its second
    const w2 = h.clock.waits.length;
    await h.api.get("PKG", conn, { path: "/chats/{chatId}/messages", params: { chatId: CHAT }, actor: user });
    await h.api.get("PKG", conn, { path: "/chats/{chatId}/messages", params: { chatId: "19:another@thread.v2" }, actor: user }); // another chat: its own bucket
    expect(h.clock.waits.length).toBe(w2);
    await h.api.get("PKG", conn, { path: "/chats/{chatId}/messages", params: { chatId: CHAT }, actor: user });
    expect(h.clock.waits.length).toBeGreaterThan(w2);
    expect(fake.state.graphRequests.length).toBe(5);
  });

  it("the guard decision is fresh: a lane switched off while a call waits for its slot refuses it without a token read", async () => {
    const { h, fake } = setup({});
    const { conn } = h.connect("PKG", PERSON);
    const a = h.api.get("PKG", conn, { path: "/me/chats", actor: user });
    h.setLane("PKG", { teams: { enabled: false } });
    await rejects(a, "connection_unavailable", /not enabled/);
    untouched(h, fake);
  });
});

describe("L3: the per-chat pacing key", () => {
  it("is a keyed hash made at process start: the same within one instance, different between two instances, and never the chat id", async () => {
    const { vi } = await import("vitest");
    const a = await import("./api");
    const x = a.chatPacingToken(CHAT);
    expect(a.chatPacingToken(CHAT)).toBe(x);
    expect(x).toMatch(/^[0-9a-f]{12}$/);
    expect(x).not.toContain("abc123");
    vi.resetModules();
    const b = await import("./api");
    expect(b.chatPacingToken(CHAT)).not.toBe(x);
  });
});
