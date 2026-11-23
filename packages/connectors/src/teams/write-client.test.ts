// The Teams Graph WRITE client (T-279, spec 6): exactly three POST templates, a body with one key, never retried, guarded for the sender, and everything else (PATCH, DELETE, reactions,
// soft delete, creating chats, marking read, other bodies) refused before a token is read. Built here in a test only: nothing in the product builds one yet (T-286, approvals).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams, TEAMS_ERROR_TEXT_CANARY } from "../testing/msw/teams/handlers";
import { createTeamsHarness, TEAMS_OTHER_USER, TEAMS_OWNER } from "../testing/teams-harness";
import { createTeamsWriteClient } from "./write-client";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const PERSON = "person@teams.example.test";
const CHAT = "19:abc123def456@thread.v2";
const TEAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function setup(features: ("chat_read" | "chat_send" | "channels_read" | "channels_send")[] = ["chat_read", "chat_send"]) {
  const fake = createFakeTeams();
  server.use(...fake.handlers);
  const h = createTeamsHarness({ fake, lanes: { PKG: { teams: { features }, mailProviders: ["google"] } } });
  const write = createTeamsWriteClient({ guard: h.guard, tokens: h.tokens, errors: h.errors, httpOptions: h.httpOptions });
  return { fake, h, write };
}
const text = (t: string) => ({ body: { contentType: "text" as const, content: t } });
const send = (t = "hello") => ({ path: "/chats/{chatId}/messages", params: { chatId: CHAT }, actorUserId: TEAMS_OWNER, body: text(t) });
const untouched = (s: ReturnType<typeof setup>) => {
  expect(s.h.stats.tokenReads).toBe(0);
  expect(s.fake.state.graphRequests).toHaveLength(0);
};

describe("the write allow-list", () => {
  it("sends one POST with exactly the documented body and nothing else", async () => {
    const s = setup();
    const { conn } = s.h.connect("PKG", PERSON, { features: ["chat_read", "chat_send"] });
    const res = await s.write.post<{ id: string }>("PKG", conn, send("Hello\nWorld"));
    expect(res.status).toBe(201);
    expect(s.fake.state.graphRequests).toHaveLength(1);
    expect(s.fake.state.graphRequests[0]).toMatchObject({ method: "POST", path: `/v1.0/chats/${CHAT.replace(/:/g, "%3A").replace(/@/g, "%40")}/messages`, body: { body: { contentType: "text", content: "Hello\nWorld" } } });
  });

  it("refuses everything else before the slot, the guard and any token read: other methods' paths, reactions, soft delete, new chats, mark read, a read template, a path with a query", async () => {
    const s = setup();
    const { conn } = s.h.connect("PKG", PERSON, { features: ["chat_read", "chat_send"] });
    const paths = [
      "/chats", "/chats/{chatId}", "/chats/{chatId}/markChatReadForUser", "/chats/{chatId}/messages/{messageId}/setReaction", "/chats/{chatId}/messages/{messageId}/softDelete",
      "/chats/{chatId}/messages/{messageId}", "/me/chats", "/me", "/chats/{chatId}/messages?x=1", "/teams/{teamId}/channels", "/teams/{teamId}/channels/{channelId}/messages/{messageId}/hostedContents/{hostedId}/$value", "/users/{userId}/sendMail", "",
    ];
    for (const path of paths) await expect(s.write.post("PKG", conn, { ...send(), path }), path).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    untouched(s);
    expect(s.h.stats.teamsSettingsReads).toBe(0);
  });

  it("the body has ONE key `body` with contentType `text` and a string content of 1 byte to 80 KB without control characters: nothing else is accepted", async () => {
    const s = setup();
    const { conn } = s.h.connect("PKG", PERSON, { features: ["chat_read", "chat_send"] });
    const bad: unknown[] = [
      null, [], "x", {}, { body: null }, { body: { contentType: "html", content: "<b>x</b>" } }, { body: { contentType: "text" } }, { body: { contentType: "text", content: "" } },
      { body: { contentType: "text", content: 5 } }, { body: { contentType: "text", content: "x", mentions: [] } }, { body: { contentType: "text", content: "x" }, attachments: [] },
      { body: { contentType: "text", content: "x" }, subject: "s" }, { body: { contentType: "text", content: "a\u0000b" } }, { body: { contentType: "text", content: "a‮b\u0085" } },
      { body: { contentType: "text", content: "x".repeat(80 * 1024 + 1) } }, { body: { contentType: "text", content: "é".repeat(41_000) } },
    ];
    for (const body of bad) await expect(s.write.post("PKG", conn, { ...send(), body: body as never }), JSON.stringify(body)?.slice(0, 60)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    untouched(s);
    // newline and tab are allowed; exactly 80 KB is allowed
    await s.write.post("PKG", conn, send("a\tb\nc"));
    await s.write.post("PKG", conn, send("x".repeat(80 * 1024)));
  });

  it("ids are validated and exactly the template's parameters are given", async () => {
    const s = setup(["chat_read", "chat_send", "channels_read", "channels_send"]);
    const { conn } = s.h.connect("PKG", PERSON, { features: ["chat_read", "chat_send", "channels_read", "channels_send"] });
    for (const params of [{ chatId: "../x" }, { chatId: "abc" }, {}, { chatId: CHAT, extra: "1" }, { chatId: "19:a/b" }]) {
      await expect(s.write.post("PKG", conn, { ...send(), params: params as never })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    }
    await expect(s.write.post("PKG", conn, { path: "/teams/{teamId}/channels/{channelId}/messages", params: { teamId: "not-a-uuid", channelId: CHAT }, actorUserId: TEAMS_OWNER, body: text("x") })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    await expect(s.write.post("PKG", conn, { ...send(), actorUserId: "nope" })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    untouched(s);
  });
});

describe("a write", () => {
  it("needs the feature on in the lane AND on the connection, and the sender to be the owner: refused before any token read", async () => {
    const lane = setup(["chat_read"]); // the lane lists no sending
    await expect(lane.write.post("PKG", lane.h.connect("PKG", PERSON, { features: ["chat_read", "chat_send"] }).conn, send())).rejects.toMatchObject({ info: { kind: "forbidden" } });
    untouched(lane);
    const conn = setup(["chat_read", "chat_send"]);
    await expect(conn.write.post("PKG", conn.h.connect("PKG", PERSON, { features: ["chat_read"] }).conn, send())).rejects.toMatchObject({ info: { kind: "forbidden" } });
    untouched(conn);
    const owner = setup();
    const c = owner.h.connect("PKG", PERSON, { features: ["chat_read", "chat_send"], owner: TEAMS_OWNER });
    await expect(owner.write.post("PKG", c.conn, { ...send(), actorUserId: TEAMS_OTHER_USER })).rejects.toMatchObject({ info: { kind: "not_found" } });
    untouched(owner);
    // a channel route needs channels_send, not chat_send
    const ch = setup(["chat_read", "chat_send"]);
    const cc = ch.h.connect("PKG", PERSON, { features: ["chat_read", "chat_send"] });
    await expect(ch.write.post("PKG", cc.conn, { path: "/teams/{teamId}/channels/{channelId}/messages", params: { teamId: TEAM, channelId: CHAT }, actorUserId: TEAMS_OWNER, body: text("x") })).rejects.toMatchObject({ info: { kind: "forbidden" } });
    untouched(ch);
  });

  it("is NEVER retried: a 5xx, a 429 and a timeout each produce exactly one POST", async () => {
    for (const status of [500, 503, 429]) {
      const s = setup();
      const { conn } = s.h.connect("PKG", PERSON, { features: ["chat_read", "chat_send"] });
      s.fake.state.graphFail = { status, code: "x", times: 5, retryAfter: 1 };
      await expect(s.write.post("PKG", conn, send())).rejects.toBeDefined();
      expect(s.fake.state.graphRequests.filter((r) => r.method === "POST"), String(status)).toHaveLength(1);
    }
    const t = setup();
    const { conn } = t.h.connect("PKG", PERSON, { features: ["chat_read", "chat_send"] });
    let calls = 0;
    const client = createTeamsWriteClient({
      guard: t.h.guard,
      tokens: t.h.tokens,
      httpOptions: { ...t.h.httpOptions, fetch: async () => { calls += 1; throw new TypeError("network down"); } },
    });
    await expect(client.post("PKG", conn, send())).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  it("a 401 means the request was not processed: one refresh and one more POST; a 403 is a fixed message with no Microsoft text, one POST", async () => {
    const s = setup();
    const { conn } = s.h.connect("PKG", PERSON, { features: ["chat_read", "chat_send"] });
    s.fake.state.unauthorizedOnce = 1;
    const ok = await s.write.post("PKG", conn, send());
    expect(ok.status).toBe(201);
    expect(s.fake.state.graphRequests.filter((r) => r.method === "POST")).toHaveLength(2);
    s.fake.state.graphRequests.length = 0;
    s.fake.state.postStatus = 403;
    const e = await s.write.post("PKG", conn, send()).then(() => null, (x: unknown) => x);
    expect(JSON.stringify(e)).not.toContain(TEAMS_ERROR_TEXT_CANARY);
    expect(s.fake.state.graphRequests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("the message text is never logged or recorded: a canary in the text appears in no log line and no api-error record", async () => {
    const s = setup();
    const { conn } = s.h.connect("PKG", PERSON, { features: ["chat_read", "chat_send"] });
    const CANARY = "teams-message-canary-91c4e7-not-real";
    s.fake.state.postStatus = 403;
    await s.write.post("PKG", conn, send(`please send ${CANARY}`)).catch(() => undefined);
    await s.write.post("PKG", conn, send(`and this ${CANARY}`));
    expect(JSON.stringify([s.h.logs, s.h.apiErrors, s.h.audits])).not.toContain(CANARY);
  });
});
