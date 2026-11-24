// The Teams channel reader (T-291): joined teams, channels (standard, private, shared), root posts with paging, replies, ids checked before any request, no request without the connection's channel
// feature, hostile HTML through the converter, deep links, and the privacy rule (a canary in every name, subject and body never reaches a log, an error or a stored write). MSW fake, synthetic data.
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams, TEAMS_ERROR_TEXT_CANARY } from "../testing/msw/teams/handlers";
import { createTeamsHarness, TEAMS_OWNER, TEAMS_TENANT_A } from "../testing/teams-harness";
import { teamsScopesFor, TEAMS_KNOWN_SCOPES } from "./constants";
import { createTeamsChannelReader } from "./channels";
import { openChannelUrl, openPostUrl } from "./deep-links";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const PERSON = "person@teams.example.test";
const CANARY = "canary-channel-content-4d2e8a10-not-real";
const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1";
const T2 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a2";
const C1 = "19:general111@thread.tacv2";
const C2 = "19:private222@thread.tacv2";
const C3 = "19:shared333@thread.tacv2";
const U1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

function setup(opts: { features?: ("chat_read" | "channels_read")[]; laneFeatures?: ("chat_read" | "channels_read")[] } = {}) {
  const fake = createFakeTeams();
  server.use(...fake.handlers);
  const h = createTeamsHarness({ fake, lanes: { PKG: { teams: { features: opts.laneFeatures ?? ["chat_read", "channels_read"] }, mailProviders: ["google"] } } });
  const c = h.connect("PKG", PERSON, { features: opts.features ?? ["chat_read", "channels_read"] });
  const reader = createTeamsChannelReader({ api: h.api });
  return { fake, h, reader, conn: c.conn, me: c.account.objectId };
}
const post = (id: string, at: string, over: Record<string, unknown> = {}) => ({ id, messageType: "message", createdDateTime: at, lastModifiedDateTime: at, lastEditedDateTime: null, deletedDateTime: null, subject: null, webUrl: null, from: { user: { id: U1, displayName: "Pat" } }, body: { contentType: "text", content: `post ${id}` }, attachments: [], ...over });
const decode = (search: string) => Object.fromEntries(new URLSearchParams(search));

describe("teams and channels", () => {
  it("lists the joined teams (names cut and sorted, a made-up id dropped, duplicates once) with one request and no option", async () => {
    const { fake, reader, conn } = setup();
    fake.state.joinedTeams = [{ id: T2, displayName: "Zed", isArchived: true }, { id: T1, displayName: "Alpha" }, { id: "not-a-guid", displayName: "x" }, { id: T1, displayName: "Alpha again" }, { nope: 1 }, "x", { id: "AAAAAAAA-AAAA-4AAA-8AAA-0000000000A3", displayName: "ㅤ" }];
    const r = await reader.listTeams("PKG", conn, TEAMS_OWNER);
    expect(r.teams.map((t) => [t.teamId, t.name, t.archived])).toEqual([["aaaaaaaa-aaaa-4aaa-8aaa-0000000000a3", "(no name)", false], [T1, "Alpha", false], [T2, "Zed", true]]); // archived only when the answer says so
    expect(r.more).toBe(false);
    expect(fake.state.graphRequests.map((q) => [q.method, q.path, q.search])).toEqual([["GET", "/v1.0/me/joinedTeams", ""]]);
  });

  it("lists a team's channels: standard, private and shared kinds; webUrl only on teams.microsoft.com; a bad channel id is not listed", async () => {
    const { fake, reader, conn } = setup();
    fake.state.channelsByTeam.set(T1, [
      { id: C1, displayName: "General", membershipType: "standard", webUrl: `https://teams.microsoft.com/l/channel/${C1}/General` },
      { id: C2, displayName: "Leads", membershipType: "private", webUrl: "https://evil.example.test/l/channel/x" },
      { id: C3, displayName: "Partners", membershipType: "shared", webUrl: "http://teams.microsoft.com/l/channel/x" },
      { id: "../etc", displayName: "bad", membershipType: "standard" },
      { id: "19:ok@thread.tacv2", displayName: "No type" },
      { id: "19:future@thread.tacv2", displayName: "Future", membershipType: "unknownFutureValue" },
    ]);
    const r = await reader.listChannels("PKG", conn, TEAMS_OWNER, T1);
    expect(r.channels.map((c) => [c.channelId, c.name, c.kind, c.webUrl !== null])).toEqual([[C1, "General", "standard", true], [C2, "Leads", "private", false], [C3, "Partners", "shared", false], ["19:ok@thread.tacv2", "No type", "standard", false], ["19:future@thread.tacv2", "Future", "other", false]]); // an unknown kind is listed, never read (the page opens it in Teams)
    expect(fake.state.graphRequests).toHaveLength(1);
    expect(fake.state.graphRequests[0]?.path).toBe(`/v1.0/teams/${T1}/channels`);
    expect(decode(fake.state.graphRequests[0]?.search ?? "")).toEqual({ $select: "id,displayName,membershipType,webUrl" });
  });

  it("a team that is gone is not_found; a 403 is forbidden; a 429 reaches the caller with its Retry-After and is not retried", async () => {
    const { fake, reader, conn } = setup();
    await expect(reader.listChannels("PKG", conn, TEAMS_OWNER, T2)).rejects.toMatchObject({ info: { kind: "not_found" } });
    fake.state.graphFail = { status: 403, code: "Forbidden", times: 1 };
    await expect(reader.listTeams("PKG", conn, TEAMS_OWNER)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    const before = fake.state.graphRequests.length;
    fake.state.graphFail = { status: 429, code: "TooManyRequests", times: 5, retryAfter: 7 };
    await expect(reader.listTeams("PKG", conn, TEAMS_OWNER)).rejects.toMatchObject({ info: { kind: "rate_limited", retry_after_seconds: 7 } });
    expect(fake.state.graphRequests.length - before).toBe(1);
  });
});

describe("posts and replies", () => {
  it("asks for $top=20 only (no $expand, no orderby), keeps Graph's order, projects subject, sender and own posts, drops a made-up post", async () => {
    const { fake, reader, conn, me } = setup();
    fake.state.channelMessages.set(`${T1}/${C1}`, [post("p1", "2026-11-20T10:00:00Z", { from: { user: { id: me, displayName: "Me" } } }), post("p2", "2026-11-21T10:00:00Z", { subject: "Budget review" }), { id: "bad id with spaces" }]);
    const r = await reader.listChannelPosts("PKG", conn, TEAMS_OWNER, T1, C1);
    expect(fake.state.graphRequests).toHaveLength(1);
    expect(fake.state.graphRequests[0]?.path).toBe(`/v1.0/teams/${T1}/channels/${encodeURIComponent(C1)}/messages`); // the id is ONE encoded path segment
    expect(decode(fake.state.graphRequests[0]?.search ?? "")).toEqual({ $top: "20" });
    expect(r.posts.map((p) => [p.id, p.subject, p.mine])).toEqual([["p2", "Budget review", false], ["p1", null, true]]);
    expect(r.nextCursor).toBeNull();
  });

  it("paging: the next page needs an explicit cursor; it is bound to this channel and holds no Graph address; a forged one is refused before any request", async () => {
    const { fake, reader, conn } = setup();
    fake.state.channelMessages.set(`${T1}/${C1}`, Array.from({ length: 25 }, (_, i) => post(`p${String(i + 1).padStart(2, "0")}`, `2026-11-${String(i + 1).padStart(2, "0")}T10:00:00Z`)));
    const p1 = await reader.listChannelPosts("PKG", conn, TEAMS_OWNER, T1, C1);
    expect(p1.posts).toHaveLength(20);
    expect(p1.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(p1.nextCursor as string, "base64url").toString()).not.toMatch(/graph\.microsoft|https?:/);
    expect(fake.state.graphRequests).toHaveLength(1); // nothing automatic
    const p2 = await reader.listChannelPosts("PKG", conn, TEAMS_OWNER, T1, C1, { cursor: p1.nextCursor as string });
    expect(p2.posts).toHaveLength(5);
    expect(p2.nextCursor).toBeNull();
    expect(decode(fake.state.graphRequests[1]?.search ?? "")).toMatchObject({ $skiptoken: "page-1", $top: "20" });
    const before = fake.state.graphRequests.length;
    // the cursor of one channel is refused for another channel, and for chats; garbage is refused
    await expect(reader.listChannelPosts("PKG", conn, TEAMS_OWNER, T1, C2, { cursor: p1.nextCursor as string })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    await expect(reader.listChannelPosts("PKG", conn, TEAMS_OWNER, T2, C1, { cursor: p1.nextCursor as string })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    for (const cursor of ["!!!", "", "a".repeat(4000), Buffer.from(JSON.stringify({ v: 1, p: "/me/chats", s: "page-1" })).toString("base64url")]) await expect(reader.listChannelPosts("PKG", conn, TEAMS_OWNER, T1, C1, { cursor })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(fake.state.graphRequests).toHaveLength(before);
  });

  it("a next link on another host or path gives no cursor", async () => {
    const { reader, conn } = setup();
    for (const link of ["https://evil.example.test/v1.0/x?$skiptoken=a", `https://graph.microsoft.com/v1.0/teams/${T1}/channels/${C2}/messages?$skiptoken=a`, `https://graph.microsoft.com/v1.0/teams/${T1}/channels/${C1}/messages?$skip=5`]) {
      server.use(http.get(`https://graph.microsoft.com/v1.0/teams/:t/channels/:c/messages`, () => HttpResponse.json({ value: [post("p1", "2026-11-21T10:00:00Z")], "@odata.nextLink": link })));
      expect((await reader.listChannelPosts("PKG", conn, TEAMS_OWNER, T1, C1)).nextCursor, link).toBeNull();
    }
  });

  it("replies: asked for with $top=50, oldest first, pictures in them stay placeholders; a deleted reply and a system event show no text", async () => {
    const { fake, reader, conn } = setup();
    fake.state.replies.set(`${T1}/${C1}/p1`, [
      post("r1", "2026-11-21T10:00:00Z", { body: { contentType: "html", content: `<p>first</p><img src="https://graph.microsoft.com/v1.0/teams/${T1}/channels/${C1}/messages/r1/hostedContents/aWQ9/$value">` } }),
      post("r2", "2026-11-21T10:05:00Z", { deletedDateTime: "2026-11-21T11:00:00Z", body: { contentType: "text", content: CANARY } }),
      post("r3", "2026-11-21T10:10:00Z", { messageType: "systemEventMessage", body: { contentType: "html", content: `<x/>${CANARY}` } }),
    ]);
    const r = await reader.listReplies("PKG", conn, TEAMS_OWNER, T1, C1, "p1");
    expect(decode(fake.state.graphRequests[0]?.search ?? "")).toEqual({ $top: "50" });
    expect(r.replies.map((x) => x.id)).toEqual(["r1", "r2", "r3"]);
    expect(r.replies[0]?.nodes.some((n) => n.t === "image" && n.hosted !== undefined)).toBe(false);
    expect(r.replies[1]).toMatchObject({ deleted: true, nodes: [] });
    expect(r.replies[2]).toMatchObject({ system: true, nodes: [] });
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(r.more).toBe(false);
  });

  it("replies: exactly one full page with no next link is NOT 'more'; a next link, or more than a page, is", async () => {
    const { fake, reader, conn } = setup();
    fake.state.replies.set(`${T1}/${C1}/p1`, Array.from({ length: 50 }, (_, i) => post(`r${String(i).padStart(2, "0")}`, `2026-11-21T10:${String(i).padStart(2, "0")}:00Z`)));
    const exact = await reader.listReplies("PKG", conn, TEAMS_OWNER, T1, C1, "p1");
    expect(exact.replies).toHaveLength(50);
    expect(exact.more).toBe(false);
    server.use(http.get("https://graph.microsoft.com/v1.0/teams/:t/channels/:c/messages/:m/replies", () => HttpResponse.json({ value: [post("r1", "2026-11-21T10:00:00Z")], "@odata.nextLink": "https://graph.microsoft.com/v1.0/teams/x/channels/y/messages/z/replies?$skiptoken=1" })));
    expect((await reader.listReplies("PKG", conn, TEAMS_OWNER, T1, C1, "p1")).more).toBe(true);
    server.use(http.get("https://graph.microsoft.com/v1.0/teams/:t/channels/:c/messages/:m/replies", () => HttpResponse.json({ value: Array.from({ length: 51 }, (_, i) => post(`q${String(i)}`, "2026-11-21T10:00:00Z")) })));
    expect((await reader.listReplies("PKG", conn, TEAMS_OWNER, T1, C1, "p1")).more).toBe(true);
  });

  it("hostile HTML in a post goes through the converter: no script, event handler, external image or javascript link; a picture of THIS post gets its hosted id", async () => {
    const { fake, reader, conn } = setup();
    const own = `https://graph.microsoft.com/v1.0/teams/${T1}/channels/${C1}/messages/p1/hostedContents/aWQ9/$value`;
    fake.state.channelMessages.set(`${T1}/${C1}`, [
      post("p1", "2026-11-21T10:00:00Z", {
        subject: `<b>Subject</b> ${"s".repeat(400)}`,
        body: { contentType: "html", content: `<script>x()</script><p onclick="x()">hi <a href="javascript:alert(1)">bad</a> <a href="https://ok.example.test/a">good</a></p><img src="https://tracker.example.test/p.gif"><img src="${own}"><img src="https://graph.microsoft.com/v1.0/teams/${T1}/channels/${C1}/messages/OTHER/hostedContents/aWQ9/$value"><at id="0">Pat</at>` },
      }),
    ]);
    const p = (await reader.listChannelPosts("PKG", conn, TEAMS_OWNER, T1, C1)).posts[0];
    const json = JSON.stringify(p?.nodes);
    expect(json).not.toMatch(/script|onclick|javascript|tracker|OTHER/);
    expect(p?.nodes.filter((n) => n.t === "image").map((n) => (n.t === "image" ? (n.hosted ?? null) : "?"))).toEqual([null, "aWQ9", null]);
    expect(p?.subject?.length).toBeLessThanOrEqual(200);
    expect(p?.subject).not.toBe(null);
  });

  it("a post's webUrl is kept only on teams.microsoft.com", async () => {
    const { fake, reader, conn } = setup();
    fake.state.channelMessages.set(`${T1}/${C1}`, [post("p1", "2026-11-21T10:00:00Z", { webUrl: "https://teams.microsoft.com/l/message/x/1" }), post("p2", "2026-11-21T11:00:00Z", { webUrl: "https://evil.example.test/x" })]);
    const r = await reader.listChannelPosts("PKG", conn, TEAMS_OWNER, T1, C1);
    expect(r.posts.map((p) => p.webUrl)).toEqual([null, "https://teams.microsoft.com/l/message/x/1"]);
  });
});

describe("what is asked for, and what is refused before any request", () => {
  it("ids are validated first: a team id that is not a UUID, a channel id with a path in it, a post id with a slash or a dot segment make no request", async () => {
    const { fake, h, reader, conn } = setup();
    const bad: [string, string, string][] = [
      ["../x", C1, "p1"],
      [T1.toUpperCase(), C1, "p1"],
      [T1, "19:a/../../b@thread.tacv2", "p1"],
      [T1, "19:a%2Fb@thread.tacv2", "p1"],
      [T1, "not-a-channel", "p1"],
      [T1, C1, "../replies"],
      [T1, C1, "a/b"],
      [T1, C1, ""],
      [T1, C1, "x".repeat(300)],
    ];
    for (const [t, c, m] of bad) {
      if (t !== T1) await expect(reader.listChannels("PKG", conn, TEAMS_OWNER, t), t).rejects.toMatchObject({ info: { kind: "invalid_input" } });
      if (t !== T1 || c !== C1) await expect(reader.listChannelPosts("PKG", conn, TEAMS_OWNER, t, c), `${t} ${c}`).rejects.toMatchObject({ info: { kind: "invalid_input" } });
      await expect(reader.listReplies("PKG", conn, TEAMS_OWNER, t, c, m), `${t} ${c} ${m}`).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    }
    expect(fake.state.graphRequests).toHaveLength(0);
    expect(h.stats.tokenReads).toBe(0);
  });

  it("a connection WITHOUT the channel feature (consent not given, or connected before it) never reaches a channel endpoint: no token read, no request", async () => {
    const { fake, h, reader, conn } = setup({ features: ["chat_read"] });
    await expect(reader.listTeams("PKG", conn, TEAMS_OWNER)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    await expect(reader.listChannels("PKG", conn, TEAMS_OWNER, T1)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    await expect(reader.listChannelPosts("PKG", conn, TEAMS_OWNER, T1, C1)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    await expect(reader.listReplies("PKG", conn, TEAMS_OWNER, T1, C1, "p1")).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(fake.state.graphRequests).toHaveLength(0);
    expect(h.stats.tokenReads).toBe(0);
  });

  it("a company that does not list channels_read is refused the same way even for a connection that has the feature", async () => {
    const { fake, h, reader, conn } = setup({ laneFeatures: ["chat_read"] });
    await expect(reader.listTeams("PKG", conn, TEAMS_OWNER)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(fake.state.graphRequests).toHaveLength(0);
    expect(h.stats.tokenReads).toBe(0);
  });

  it("another person (an admin) is refused: the owner of the row must be the actor", async () => {
    const { fake, h, reader, conn } = setup();
    await expect(reader.listTeams("PKG", conn, "00000000-0000-4000-8000-0000000b0279")).rejects.toMatchObject({ info: { kind: "not_found" } });
    expect(fake.state.graphRequests).toHaveLength(0);
    expect(h.stats.tokenReads).toBe(0);
  });

  it("a connection of another lane is refused before anything is read", async () => {
    const { fake, reader, conn } = setup();
    await expect(reader.listTeams("NC" as never, conn, TEAMS_OWNER)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
    expect(fake.state.graphRequests).toHaveLength(0);
  });

  it("the scopes: channels are requested only when the company lists channels_read, and all three channel scopes are on the app's known list", () => {
    expect(teamsScopesFor(["chat_read"])).not.toContain("ChannelMessage.Read.All");
    expect(teamsScopesFor(["chat_read", "channels_read"])).toEqual(expect.arrayContaining(["Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Read.All"]));
    for (const s of ["team.readbasic.all", "channel.readbasic.all", "channelmessage.read.all"]) expect(TEAMS_KNOWN_SCOPES.has(s)).toBe(true);
  });

  it("the reader never sends anything but GET, and never a /tenants/ segment or a beta path", async () => {
    const { fake, reader, conn } = setup();
    fake.state.joinedTeams = [{ id: T1, displayName: "A" }];
    fake.state.channelsByTeam.set(T1, [{ id: C3, displayName: "S", membershipType: "shared" }]);
    fake.state.channelMessages.set(`${T1}/${C1}`, [post("p1", "2026-11-21T10:00:00Z")]);
    fake.state.replies.set(`${T1}/${C1}/p1`, [post("r1", "2026-11-21T10:01:00Z")]);
    await reader.listTeams("PKG", conn, TEAMS_OWNER);
    await reader.listChannels("PKG", conn, TEAMS_OWNER, T1);
    await reader.listChannelPosts("PKG", conn, TEAMS_OWNER, T1, C1);
    await reader.listReplies("PKG", conn, TEAMS_OWNER, T1, C1, "p1");
    expect(fake.state.graphRequests.map((r) => r.method)).toEqual(["GET", "GET", "GET", "GET"]);
    for (const r of fake.state.graphRequests) expect(r.path).toMatch(/^\/v1\.0\/(me\/joinedTeams|teams\/[0-9a-f-]{36}\/channels)/);
    expect(JSON.stringify(fake.state.graphRequests.map((r) => r.path))).not.toMatch(/tenants|beta/);
  });
});

describe("privacy (rules 6 and 9)", () => {
  it("a canary in a team name, channel name, subject, body, reply and sender never reaches a log line, a stored write or an error", async () => {
    const { fake, h, reader, conn, me } = setup();
    fake.state.joinedTeams = [{ id: T1, displayName: `Team ${CANARY}` }];
    fake.state.channelsByTeam.set(T1, [{ id: C1, displayName: `Chan ${CANARY}`, membershipType: "standard" }]);
    fake.state.channelMessages.set(`${T1}/${C1}`, [post("p1", "2026-11-21T10:00:00Z", { subject: CANARY, body: { contentType: "text", content: CANARY }, from: { user: { id: me, displayName: CANARY } } })]);
    fake.state.replies.set(`${T1}/${C1}/p1`, [post("r1", "2026-11-21T10:01:00Z", { body: { contentType: "html", content: `<p>${CANARY}</p>` } })]);
    const writesBefore = h.writeCount();
    await reader.listTeams("PKG", conn, TEAMS_OWNER);
    await reader.listChannels("PKG", conn, TEAMS_OWNER, T1);
    await reader.listChannelPosts("PKG", conn, TEAMS_OWNER, T1, C1);
    await reader.listReplies("PKG", conn, TEAMS_OWNER, T1, C1, "p1");
    expect(h.writeCount()).toBe(writesBefore);
    expect(JSON.stringify([h.logs, h.audits, h.apiErrors, h.reconnects])).not.toContain(CANARY);
    fake.state.graphFail = { status: 500, code: "Boom", times: 1 };
    const e = await reader.listChannelPosts("PKG", conn, TEAMS_OWNER, T1, C1).catch((x: unknown) => x);
    expect(JSON.stringify(e)).not.toContain(TEAMS_ERROR_TEXT_CANARY);
    expect(JSON.stringify([h.logs, h.audits, h.apiErrors])).not.toContain(TEAMS_ERROR_TEXT_CANARY);
  });
});

describe("Open in Teams links (vendor facts D7)", () => {
  it("a channel opens through its own teams.microsoft.com webUrl; anything else opens Teams itself", () => {
    expect(openChannelUrl(`https://teams.microsoft.com/l/channel/${C1}/General?groupId=${T1}`)).toBe(`https://teams.microsoft.com/l/channel/${C1}/General?groupId=${T1}`);
    for (const bad of [null, undefined, "", "https://evil.example.test/l/channel/x", "http://teams.microsoft.com/x", "javascript:alert(1)", "https://teams.microsoft.com.evil.example.test/x", "https://user:pw@teams.microsoft.com/x"]) expect(openChannelUrl(bad)).toBe("https://teams.microsoft.com");
  });

  it("a post opens through its webUrl, else through the documented channel-message link built from validated ids only; a bad id throws", () => {
    expect(openPostUrl({ webUrl: "https://teams.microsoft.com/l/message/x/1", channelId: C1, messageId: "p1", teamId: T1, tenantId: TEAMS_TENANT_A })).toBe("https://teams.microsoft.com/l/message/x/1");
    expect(openPostUrl({ webUrl: "https://evil.example.test/x", channelId: C1, messageId: "1700000000001", teamId: T1, tenantId: TEAMS_TENANT_A })).toBe(`https://teams.microsoft.com/l/message/${C1}/1700000000001?tenantId=${TEAMS_TENANT_A}&groupId=${T1}&parentMessageId=1700000000001`);
    for (const p of [{ channelId: "19:a/b@thread", messageId: "1", teamId: T1, tenantId: TEAMS_TENANT_A }, { channelId: C1, messageId: "1&x=y", teamId: T1, tenantId: TEAMS_TENANT_A }, { channelId: C1, messageId: "1", teamId: "x", tenantId: TEAMS_TENANT_A }, { channelId: C1, messageId: "1", teamId: T1, tenantId: "t&x" }]) {
      expect(() => openPostUrl({ webUrl: null, ...p })).toThrow();
    }
  });
});
