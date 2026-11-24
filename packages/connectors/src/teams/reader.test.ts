// The Teams chat reader (T-281, T-284): the projections, the unread rule, paging, the expand fallback, pacing and throttling, ids checked before any request, and the privacy rule: a canary in
// every piece of Teams content never reaches a log, an audit row, a stored write, an API-error row or an error. MSW fake of Graph, synthetic data only.
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams, TEAMS_ERROR_TEXT_CANARY } from "../testing/msw/teams/handlers";
import { createTeamsHarness, TEAMS_OTHER_USER, TEAMS_OWNER, TEAMS_TENANT_A, TEAMS_TENANT_B, type TeamsLaneSetup } from "../testing/teams-harness";
import { callBlockReason, chatIsUnread, createTeamsReader, isMicrosoftFileHost, normalizeTime, upnOf, type ChatMessage, type TeamsChat } from "./reader";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const DOMAIN = "teams.example.test";
const PERSON = `person@${DOMAIN}`;
const CANARY = "canary-teams-content-9f3c1e77-not-real";
const CHAT = "19:abc123def456@thread.v2";
const CHAT2 = "19:other456abc@thread.v2";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const U2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const U3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

function setup(lane: Partial<TeamsLaneSetup> = {}) {
  const fake = createFakeTeams();
  server.use(...fake.handlers);
  const h = createTeamsHarness({ fake, lanes: { PKG: { teams: { features: ["chat_read", "call_links"] }, mailProviders: ["google"], ...lane } } });
  const lines: LogEntry[] = [];
  const reader = createTeamsReader({ api: h.api, logger: createConnectorLogger({ sink: (e) => lines.push(e) }) });
  const c = h.connect("PKG", PERSON);
  const me = c.account.objectId;
  return { fake, h, reader, lines, conn: c.conn, me };
}
const member = (userId: string, name: string, tenantId = TEAMS_TENANT_A) => ({ id: `m-${userId}`, roles: [], displayName: name, userId, tenantId, email: null });
const html = (content: string) => ({ contentType: "html", content });
const preview = (at: string, fromId: string, content = "hello", contentType = "text") => ({ id: "1", createdDateTime: at, isDeleted: false, messageType: "message", from: { user: { id: fromId, displayName: "Sender" } }, body: { contentType, content } });
const chat = (id: string, over: Record<string, unknown> = {}) => ({ id, chatType: "group", topic: null, webUrl: `https://teams.microsoft.com/l/chat/${id}/0`, viewpoint: { isHidden: false, lastMessageReadDateTime: "2026-11-20T10:00:00Z" }, members: [], lastMessagePreview: null, ...over });
const msg = (id: string, at: string, over: Record<string, unknown> = {}) => ({ id, messageType: "message", createdDateTime: at, lastModifiedDateTime: at, lastEditedDateTime: null, deletedDateTime: null, from: { user: { id: U1, displayName: "Pat" } }, body: { contentType: "text", content: `text ${id}` }, attachments: [], ...over });
const asUser = TEAMS_OWNER;
const decode = (search: string) => Object.fromEntries(new URLSearchParams(search));

describe("listChats", () => {
  it("asks Graph for the documented options only: combined expand, the one supported orderby, $top 50; and maps members, previews and flags", async () => {
    const { fake, reader, conn, me } = setup();
    fake.state.chatPages = [
      [
        chat(CHAT, { topic: "Budget", members: [member(me, "Me"), member(U1, "Pat Example"), member(U2, "Guest Person", TEAMS_TENANT_B)], lastMessagePreview: preview("2026-11-21T09:00:00.1234567Z", U1, "<p>see <b>this</b> <at id='0'>Me</at></p>", "html") }),
        chat(CHAT2, { chatType: "oneOnOne", members: [member(me, "Me"), member(U1, "Pat Example")], lastMessagePreview: preview("2026-11-21T08:00:00Z", me, "mine") }),
      ],
    ];
    const r = await reader.listChats("PKG", conn, asUser);
    expect(fake.state.graphRequests).toHaveLength(1);
    expect(decode(fake.state.graphRequests[0]?.search ?? "")).toEqual({ $expand: "members,lastMessagePreview", $orderby: "lastMessagePreview/createdDateTime desc", $top: "50" });
    expect(r.chats.map((c) => c.chatId)).toEqual([CHAT, CHAT2]);
    const first = r.chats[0] as TeamsChat;
    expect(first.topic).toBe("Budget");
    expect(first.members.map((m) => [m.displayName, m.external, m.self])).toEqual([["Me", false, true], ["Pat Example", false, false], ["Guest Person", true, false]]);
    expect(first.preview).toMatchObject({ createdAt: "2026-11-21T09:00:00.123Z", mine: false, text: "see this @Me", deleted: false, system: false });
    expect(first.webUrl).toBe(`https://teams.microsoft.com/l/chat/${CHAT}/0`);
    expect(r.chats[1]?.preview?.mine).toBe(true);
    expect(r.nextCursor).toBeNull();
  });

  it("a hidden chat is not listed; a chat with a bad id or no usable shape is dropped without failing the page", async () => {
    const { fake, reader, conn } = setup();
    fake.state.chatPages = [[chat(CHAT, { viewpoint: { isHidden: true } }), chat(CHAT2), { id: "not-a-chat-id" }, { nope: 1 }, "x", null]];
    const r = await reader.listChats("PKG", conn, asUser);
    expect(r.chats.map((c) => c.chatId)).toEqual([CHAT2]);
  });

  it("a webUrl on another host or another scheme is dropped (Open in Teams is rebuilt from the chat id)", async () => {
    const { fake, reader, conn } = setup();
    fake.state.chatPages = [[chat(CHAT, { webUrl: "https://evil.example.test/l/chat/x" }), chat(CHAT2, { webUrl: "http://teams.microsoft.com/l/chat/x" })]];
    const r = await reader.listChats("PKG", conn, asUser);
    expect(r.chats.map((c) => c.webUrl)).toEqual([null, null]);
  });

  it("a deleted preview and a system preview show no text", async () => {
    const { fake, reader, conn } = setup();
    fake.state.chatPages = [[
      chat(CHAT, { lastMessagePreview: { ...preview("2026-11-21T09:00:00Z", U1, `deleted ${CANARY}`), isDeleted: true } }),
      chat(CHAT2, { lastMessagePreview: { ...preview("2026-11-21T09:00:00Z", U1, `event ${CANARY}`), messageType: "systemEventMessage" } }),
    ]];
    const r = await reader.listChats("PKG", conn, asUser);
    expect(r.chats.map((c) => [c.preview?.text, c.preview?.deleted, c.preview?.system])).toEqual([["", true, false], ["", false, true]]);
  });

  it("a long preview is cut at 160 characters; hostile markup in it is plain text only", async () => {
    const { fake, reader, conn } = setup();
    fake.state.chatPages = [[chat(CHAT, { lastMessagePreview: preview("2026-11-21T09:00:00Z", U1, `<script>x()</script><img src=https://t.example.test/p.gif onerror=x()>${"w".repeat(500)}`, "html") })]];
    const r = await reader.listChats("PKG", conn, asUser);
    const text = r.chats[0]?.preview?.text ?? "";
    expect(text).toBe(("[image]" + "w".repeat(500)).slice(0, 160)); // the image is a placeholder word, the script is gone
  });

  it("paging: the next page needs an explicit cursor; the cursor holds no Graph address and a forged one is refused before any request", async () => {
    const { fake, reader, conn } = setup();
    fake.state.chatPages = [[chat(CHAT)], [chat(CHAT2)]];
    const p1 = await reader.listChats("PKG", conn, asUser);
    expect(p1.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(p1.nextCursor as string, "base64url").toString()).not.toMatch(/graph\.microsoft|https?:/);
    expect(fake.state.graphRequests).toHaveLength(1); // no automatic second request
    const p2 = await reader.listChats("PKG", conn, asUser, { cursor: p1.nextCursor as string });
    expect(p2.chats.map((c) => c.chatId)).toEqual([CHAT2]);
    expect(p2.nextCursor).toBeNull();
    expect(decode(fake.state.graphRequests[1]?.search ?? "")).toMatchObject({ $skiptoken: "page-1", $top: "50" });

    const before = fake.state.graphRequests.length;
    const forged = [
      "!!!", "", "a".repeat(4000),
      Buffer.from(JSON.stringify({ v: 1, p: "/chats/x/messages", s: "page-1" })).toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, p: "/me/chats", s: "a&$expand=x" })).toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, p: "/me/chats", s: "a b" })).toString("base64url"),
      Buffer.from(JSON.stringify({ v: 2, p: "/me/chats", s: "ok" })).toString("base64url"),
      Buffer.from("not json").toString("base64url"),
    ];
    for (const cursor of forged) await expect(reader.listChats("PKG", conn, asUser, { cursor })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(fake.state.graphRequests).toHaveLength(before);
  });

  it("a next link on another host, with another path or without a skip token gives no cursor (it is never followed or passed on)", async () => {
    const { reader, conn } = setup();
    for (const link of ["https://evil.example.test/v1.0/me/chats?$skiptoken=x", "https://graph.microsoft.com/v1.0/users?$skiptoken=x", "https://graph.microsoft.com/v1.0/me/chats?$skip=50", "http://graph.microsoft.com/v1.0/me/chats?$skiptoken=x", "https://user@graph.microsoft.com/v1.0/me/chats?$skiptoken=x"]) {
      server.use(http.get("https://graph.microsoft.com/v1.0/me/chats", () => HttpResponse.json({ value: [chat(CHAT)], "@odata.nextLink": link })));
      const r = await reader.listChats("PKG", conn, asUser);
      expect(r.nextCursor, link).toBeNull();
    }
  });

  it("when Graph refuses the combined expand (400), previews are asked for alone, members are read for the chats in parallel (at most 20) and the fallback is logged without content", async () => {
    const { fake, reader, conn, me, lines } = setup();
    fake.state.refuseCombinedExpand = true;
    const ids = Array.from({ length: 25 }, (_, i) => `19:chat${String(i)}@thread.v2`);
    fake.state.chatPages = [ids.map((id) => chat(id, { topic: CANARY, lastMessagePreview: preview("2026-11-21T09:00:00Z", U1, CANARY), members: [member(me, `Me ${CANARY}`)] }))];
    for (const id of ids) fake.state.membersByChat.set(id, [member(me, "Me"), member(U1, `Pat ${CANARY}`)]);
    const r = await reader.listChats("PKG", conn, asUser);
    expect(r.chats).toHaveLength(25);
    const reqs = fake.state.graphRequests;
    expect(reqs.filter((q) => q.path === "/v1.0/me/chats")).toHaveLength(2);
    expect(decode(reqs[1]?.search ?? "").$expand).toBe("lastMessagePreview");
    const memberReads = reqs.filter((q) => q.path.endsWith("/members"));
    expect(memberReads).toHaveLength(20);
    expect(r.chats.slice(0, 20).every((c) => c.members.some((m) => m.displayName.startsWith("Pat")))).toBe(true);
    expect(r.chats.slice(20).every((c) => c.members.length === 0)).toBe(true);
    expect(lines.filter((l) => l.event === "teams.chats.expand_fallback")).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });

  it("T-294: the member fallback reads at most the budget the caller gives (the page splits its 20 across accounts); never more than 20, never a negative or fractional count", async () => {
    for (const [budget, expected] of [[10, 10], [0, 0], [-4, 0], [7.9, 7], [99, 20]] as const) {
      const { fake, reader, conn, me } = setup();
      fake.state.refuseCombinedExpand = true;
      const ids = Array.from({ length: 25 }, (_, i) => `19:chat${String(i)}@thread.v2`);
      fake.state.chatPages = [ids.map((id) => chat(id, { topic: "t", lastMessagePreview: preview("2026-11-21T09:00:00Z", U1, "x"), members: [member(me, "Me")] }))];
      for (const id of ids) fake.state.membersByChat.set(id, [member(me, "Me"), member(U1, "Pat")]);
      await reader.listChats("PKG", conn, asUser, { memberReads: budget });
      expect(fake.state.graphRequests.filter((q) => q.path.endsWith("/members")), String(budget)).toHaveLength(expected);
    }
  });

  it("any other failure is not a fallback: a 403 is raised as it is", async () => {
    const { fake, reader, conn } = setup();
    fake.state.graphFail = { status: 403, code: "Forbidden", times: 5 };
    await expect(reader.listChats("PKG", conn, asUser)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(fake.state.graphRequests).toHaveLength(1);
  });
});

describe("unread (spec 8.1)", () => {
  const base = (over: Partial<Pick<TeamsChat, "preview" | "lastReadAt" | "hidden">> = {}) => ({ hidden: false, lastReadAt: "2026-11-20T10:00:00.000Z", preview: { createdAt: "2026-11-21T09:00:00.000Z", senderId: U1, senderName: "x", mine: false, text: "", deleted: false, system: false }, ...over });

  it("a newer message from someone else is unread", () => {
    expect(chatIsUnread(base(), null)).toBe(true);
  });
  it("the newest message is the person's own: not unread", () => {
    expect(chatIsUnread(base({ preview: { ...(base().preview as NonNullable<TeamsChat["preview"]>), mine: true } }), null)).toBe(false);
  });
  it("hidden: not unread; no preview: not unread", () => {
    expect(chatIsUnread(base({ hidden: true }), null)).toBe(false);
    expect(chatIsUnread(base({ preview: null }), null)).toBe(false);
  });
  it("Teams' own read time at or after the newest message: not unread", () => {
    expect(chatIsUnread(base({ lastReadAt: "2026-11-21T09:00:00.000Z" }), null)).toBe(false);
    expect(chatIsUnread(base({ lastReadAt: "2026-11-22T09:00:00.000Z" }), null)).toBe(false);
  });
  it("the portal's marker newer than Teams' read time clears it; an older marker does not; the later of the two wins", () => {
    expect(chatIsUnread(base(), "2026-11-21T09:00:00.000Z")).toBe(false);
    expect(chatIsUnread(base(), "2026-11-21T09:00:00.500Z")).toBe(false);
    expect(chatIsUnread(base(), "2026-11-19T00:00:00.000Z")).toBe(true);
    expect(chatIsUnread(base({ lastReadAt: null }), "2026-11-19T00:00:00.000Z")).toBe(true);
    expect(chatIsUnread(base({ lastReadAt: null }), null)).toBe(true);
  });
  it("a message that arrives after the marker is unread again", () => {
    expect(chatIsUnread(base({ preview: { ...(base().preview as NonNullable<TeamsChat["preview"]>), createdAt: "2026-11-21T09:00:01.000Z" } }), "2026-11-21T09:00:00.000Z")).toBe(true);
  });
  it("a marker with 7 fractional digits at Microsoft's own precision never leaves a chat unread forever (compared at millisecond precision)", () => {
    const at = normalizeTime("2026-11-21T09:00:00.1234567Z") as string;
    expect(at).toBe("2026-11-21T09:00:00.123Z");
    expect(chatIsUnread(base({ preview: { ...(base().preview as NonNullable<TeamsChat["preview"]>), createdAt: at } }), at)).toBe(false);
  });
});

describe("listMessages", () => {
  it("the first page: newest first, $top 30 ordered by createdDateTime; maps deleted, edited, system, mine, attachments and bodies", async () => {
    const { fake, reader, conn, me } = setup();
    fake.state.messagesByChat.set(CHAT, [
      msg("m1", "2026-11-21T09:00:00Z", { from: { user: { id: me, displayName: "Me" } }, body: html("<p>hi <at id='0'>Pat</at> <img src='https://tracker.example.test/p.gif'></p>") }),
      msg("m2", "2026-11-21T08:00:00Z", { deletedDateTime: "2026-11-21T08:30:00Z", body: { contentType: "text", content: `deleted ${CANARY}` }, attachments: [{ contentType: "reference", contentUrl: "https://files.example.test/a.docx", name: "a.docx" }] }),
      msg("m3", "2026-11-21T07:00:00Z", { lastEditedDateTime: "2026-11-21T07:05:00Z", body: html("<a href='javascript:alert(1)'>x</a> edited") }),
      msg("m4", "2026-11-21T06:00:00Z", { messageType: "systemEventMessage", body: { contentType: "html", content: `<systemEventMessage/>${CANARY}` } }),
      msg("m5", "2026-11-21T05:00:00Z", {
        attachments: [
          { contentType: "reference", contentUrl: "https://contoso.sharepoint.com/f/a.docx", name: "Plan.docx" },
          { contentType: "reference", contentUrl: "javascript:alert(1)", name: "bad.docx" },
          { contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, name: "A card" },
          { contentType: "messageReference", contentUrl: null, name: null },
          { contentType: "text/plain", contentUrl: null, name: "n" },
        ],
      }),
      { id: "m6", createdDateTime: "not a time" },
    ]);
    const r = await reader.listMessages("PKG", conn, asUser, CHAT);
    expect(decode(fake.state.graphRequests[0]?.search ?? "")).toEqual({ $top: "30", $orderby: "createdDateTime desc" });
    expect(r.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(r.nextBefore).toBeNull();
    const [m1, m2, m3, m4, m5] = r.messages as [ChatMessage, ChatMessage, ChatMessage, ChatMessage, ChatMessage];
    expect(m1.mine).toBe(true);
    expect(JSON.stringify(m1.nodes)).toContain("@Pat");
    expect(JSON.stringify(m1.nodes)).not.toContain("tracker");
    expect(m2).toMatchObject({ deleted: true, nodes: [], attachments: [] });
    expect(m3.edited).toBe(true);
    expect(JSON.stringify(m3.nodes)).not.toContain("javascript");
    expect(m4).toMatchObject({ system: true, nodes: [] });
    expect(m5.attachments).toEqual([
      { kind: "file", name: "Plan.docx", href: "https://contoso.sharepoint.com/f/a.docx", host: "contoso.sharepoint.com" },
      { kind: "file", name: "bad.docx", href: null, host: null },
      { kind: "card", name: "A card", href: null, host: null },
      { kind: "reply", name: "", href: null, host: null },
      { kind: "other", name: "n", href: null, host: null },
    ]);
    expect(JSON.stringify(r.messages)).not.toContain(CANARY);
  });

  it("paging back: a full page offers the oldest createdAt; the next request filters createdDateTime lt that time, with the orderby it needs", async () => {
    const { fake, reader, conn } = setup();
    fake.state.messagesByChat.set(CHAT, Array.from({ length: 45 }, (_, i) => msg(`n${String(i)}`, new Date(Date.UTC(2026, 10, 21, 9, 0, 0) - i * 60_000).toISOString())));
    const p1 = await reader.listMessages("PKG", conn, asUser, CHAT);
    expect(p1.messages).toHaveLength(30);
    expect(p1.nextBefore).toBe(p1.messages[29]?.createdAt);
    const p2 = await reader.listMessages("PKG", conn, asUser, CHAT, { before: p1.nextBefore as string });
    expect(decode(fake.state.graphRequests[1]?.search ?? "")).toEqual({ $top: "30", $orderby: "createdDateTime desc", $filter: `createdDateTime lt ${p1.nextBefore as string}` });
    expect(p2.messages).toHaveLength(15);
    expect(p2.nextBefore).toBeNull();
    expect(new Set([...p1.messages, ...p2.messages].map((m) => m.id)).size).toBe(45);
  });

  it("new since a time: lastModifiedDateTime gt <t> ordered by the same property, $top 50 (a date range, as the terms ask)", async () => {
    const { fake, reader, conn } = setup();
    fake.state.messagesByChat.set(CHAT, [msg("a", "2026-11-21T09:00:00Z"), msg("b", "2026-11-21T08:00:00Z", { lastModifiedDateTime: "2026-11-21T09:30:00Z" })]);
    const r = await reader.listMessages("PKG", conn, asUser, CHAT, { sinceModified: "2026-11-21T08:45:00Z" });
    expect(decode(fake.state.graphRequests[0]?.search ?? "")).toEqual({ $top: "50", $orderby: "lastModifiedDateTime desc", $filter: "lastModifiedDateTime gt 2026-11-21T08:45:00.000Z" });
    expect(r.messages.map((m) => m.id)).toEqual(["b", "a"]);
    expect(r.nextBefore).toBeNull();
    expect(r.truncated).toBe(false);
  });

  it("new since a time: a full page (50) is `truncated` (changes may be missing: the caller reads the chat again instead of merging); a page of 49 is not; a normal page read has no flag", async () => {
    const { fake, reader, conn } = setup();
    const many = (n: number) => Array.from({ length: n }, (_, i) => msg(`m${String(i)}`, `2026-11-21T09:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`));
    fake.state.messagesByChat.set(CHAT, many(50));
    expect((await reader.listMessages("PKG", conn, asUser, CHAT, { sinceModified: "2026-11-21T08:00:00Z" })).truncated).toBe(true);
    fake.state.messagesByChat.set(CHAT, many(49));
    expect((await reader.listMessages("PKG", conn, asUser, CHAT, { sinceModified: "2026-11-21T08:00:00Z" })).truncated).toBe(false);
    expect((await reader.listMessages("PKG", conn, asUser, CHAT)).truncated).toBeUndefined();
  });

  it("the times in a filter are validated and rebuilt, never pasted; both options together are refused; nothing is sent", async () => {
    const { fake, reader, conn } = setup();
    for (const bad of ["2026-11-21T09:00:00Z' or true", "x", "2026-11-21", "2026-11-21T09:00:00+02:00", "2026-13-45T99:00:00Z", "2026-11-21T09:00:00Z ", "$(x)"]) {
      await expect(reader.listMessages("PKG", conn, asUser, CHAT, { before: bad })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
      await expect(reader.listMessages("PKG", conn, asUser, CHAT, { sinceModified: bad })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    }
    await expect(reader.listMessages("PKG", conn, asUser, CHAT, { before: "2026-11-21T09:00:00Z", sinceModified: "2026-11-21T09:00:00Z" })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(fake.state.graphRequests).toHaveLength(0);
  });

  it("a chat id that is not a chat id is refused before any request", async () => {
    const { fake, h, reader, conn } = setup();
    for (const id of ["../me", "19:x/../me", "abc", "", `19:${"a".repeat(300)}`, "19:%2e%2e"]) await expect(reader.listMessages("PKG", conn, asUser, id)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(fake.state.graphRequests).toHaveLength(0);
    expect(h.stats.tokenReads).toBe(0);
  });
});

describe("throttling and pacing (vendor facts A2)", () => {
  it("a 429 reaches the caller at once with its Retry-After; the request is not retried", async () => {
    const { fake, reader, conn } = setup();
    fake.state.graphFail = { status: 429, code: "TooManyRequests", times: 10, retryAfter: 7 };
    const e = await reader.listChats("PKG", conn, asUser).then(() => null, (x: unknown) => x as { info: { kind: string; retry_after_seconds: number; http_status: number; message: string } });
    expect(e?.info).toMatchObject({ kind: "rate_limited", retry_after_seconds: 7, http_status: 429 });
    expect(e?.info.message).not.toContain(TEAMS_ERROR_TEXT_CANARY);
    expect(fake.state.graphRequests).toHaveLength(1);
    fake.state.graphRequests.length = 0;
    fake.state.graphFail = { status: 429, code: "TooManyRequests", times: 10, retryAfter: 2 };
    await expect(reader.listMessages("PKG", conn, asUser, CHAT)).rejects.toMatchObject({ info: { kind: "rate_limited", retry_after_seconds: 2 } });
    expect(fake.state.graphRequests).toHaveLength(1);
  });

  it("a 5xx is not retried by a page read either", async () => {
    const { fake, reader, conn } = setup();
    fake.state.graphFail = { status: 503, code: "ServiceNotAvailable", times: 10 };
    await expect(reader.listMessages("PKG", conn, asUser, CHAT)).rejects.toMatchObject({ info: { kind: "transient" } });
    expect(fake.state.graphRequests).toHaveLength(1);
  });

  it("one person's chat list and one chat's messages are paced at one request a second each (own buckets; the virtual clock records the waits)", async () => {
    const { h, reader, conn } = setup();
    await reader.listChats("PKG", conn, asUser);
    const w1 = h.clock.waits.length;
    await reader.listChats("PKG", conn, asUser);
    expect(h.clock.waits.length).toBeGreaterThan(w1); // the second `/me/chats` waited for its second
    const w2 = h.clock.waits.length;
    await Promise.all([reader.listMessages("PKG", conn, asUser, CHAT), reader.listMessages("PKG", conn, asUser, CHAT2)]);
    expect(h.clock.waits.length).toBe(w2); // different chats are different buckets
    await reader.listMessages("PKG", conn, asUser, CHAT);
    expect(h.clock.waits.length).toBeGreaterThan(w2);
  });
});

describe("who may read", () => {
  it("another person (even an admin of the lane) reading this connection's chats is refused before any token read or request", async () => {
    const { fake, h, reader, conn } = setup();
    await expect(reader.listChats("PKG", conn, TEAMS_OTHER_USER)).rejects.toMatchObject({ info: { kind: "not_found" } });
    await expect(reader.listMessages("PKG", conn, TEAMS_OTHER_USER, CHAT)).rejects.toMatchObject({ info: { kind: "not_found" } });
    await expect(reader.resolveCallTargets("PKG", conn, TEAMS_OTHER_USER, CHAT)).rejects.toMatchObject({ info: { kind: "not_found" } });
    expect(fake.state.graphRequests).toHaveLength(0);
    expect(h.stats.tokenReads).toBe(0);
  });

  it("a lane or a connection without chat_read is refused", async () => {
    const lane = setup({ teams: { features: ["call_links"] } });
    await expect(lane.reader.listChats("PKG", lane.conn, asUser)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(lane.fake.state.graphRequests).toHaveLength(0);
  });

  it("a malformed user id as the actor is refused", async () => {
    const { fake, reader, conn } = setup();
    await expect(reader.listChats("PKG", conn, "nobody")).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(fake.state.graphRequests).toHaveLength(0);
  });
});

describe("privacy (rule 6): a canary in every piece of Teams content never leaves the request", () => {
  it("not in a log line, an audit row, an API-error row, a stored write or a thrown error", async () => {
    const { fake, h, reader, conn, me, lines } = setup();
    fake.state.chatPages = [[chat(CHAT, { topic: `topic ${CANARY}`, members: [member(me, "Me"), member(U1, `Pat ${CANARY}`)], lastMessagePreview: preview("2026-11-21T09:00:00Z", U1, `preview ${CANARY}`) })]];
    fake.state.membersByChat.set(CHAT, [member(me, "Me"), member(U1, `Pat ${CANARY}`)]);
    fake.state.messagesByChat.set(CHAT, [msg("m1", "2026-11-21T09:00:00Z", { body: html(`<p>${CANARY}</p>`), from: { user: { id: U1, displayName: `Pat ${CANARY}` } }, attachments: [{ contentType: "reference", contentUrl: "https://f.example.test/x", name: `file ${CANARY}.docx` }] })]);
    fake.state.upnByUser.set(U1, `pat@${DOMAIN}`);
    const writesBefore = h.writeCount();
    const list = await reader.listChats("PKG", conn, asUser);
    const msgs = await reader.listMessages("PKG", conn, asUser, CHAT);
    await reader.resolveCallTargets("PKG", conn, asUser, CHAT);
    // the content IS returned to the caller of the request (that is the point) ...
    expect(JSON.stringify(list)).toContain(CANARY);
    expect(JSON.stringify(msgs)).toContain(CANARY);
    // ... and nowhere else
    expect(JSON.stringify(lines)).not.toContain(CANARY);
    expect(JSON.stringify(h.logs)).not.toContain(CANARY);
    expect(JSON.stringify(h.audits)).not.toContain(CANARY);
    expect(JSON.stringify(h.apiErrors)).not.toContain(CANARY);
    expect(JSON.stringify([...h.secrets.values()])).not.toContain(CANARY);
    expect(h.writeCount()).toBe(writesBefore); // a read writes nothing at all
    // errors: Graph's error text carries the canary; the thrown error and the recorded one do not
    fake.state.graphFail = { status: 400, code: "BadRequest", times: 5 };
    fake.state.refuseCombinedExpand = false;
    const e = await reader.listMessages("PKG", conn, asUser, CHAT).then(() => null, (x: unknown) => x);
    expect(e).not.toBeNull();
    expect(JSON.stringify(e)).not.toContain(TEAMS_ERROR_TEXT_CANARY);
    expect(String((e as Error).message)).not.toContain(TEAMS_ERROR_TEXT_CANARY);
    expect(JSON.stringify(h.apiErrors)).not.toContain(TEAMS_ERROR_TEXT_CANARY);
    expect(JSON.stringify(h.logs)).not.toContain(TEAMS_ERROR_TEXT_CANARY);
  });

  it("the reader holds no state between calls: a second reader sees nothing of the first", async () => {
    const { fake, reader, conn } = setup();
    fake.state.chatPages = [[chat(CHAT, { topic: CANARY })]];
    await reader.listChats("PKG", conn, asUser);
    fake.state.chatPages = [[]];
    const again = await reader.listChats("PKG", conn, asUser);
    expect(again.chats).toEqual([]);
  });
});

describe("getChat and the call rule", () => {
  it("getChat reads one chat's own fields from the one fixed template: topic, type, https teams link; no members, no preview", async () => {
    const { fake, reader, conn } = setup();
    fake.state.chatById.set(CHAT, chat(CHAT, { topic: "Plan", chatType: "oneOnOne", members: [member(U1, "Should not be read")], lastMessagePreview: preview("2026-11-21T09:00:00Z", U1) }));
    const r = await reader.getChat("PKG", conn, asUser, CHAT);
    expect(r.chat).toMatchObject({ chatId: CHAT, topic: "Plan", chatType: "oneOnOne" });
    expect(fake.state.graphRequests.map((q) => q.path)).toEqual([`/v1.0/chats/${encodeURIComponent(CHAT)}`]);
    expect(fake.state.graphRequests[0]?.search).toBe("");
    await expect(reader.getChat("PKG", conn, asUser, CHAT2)).rejects.toMatchObject({ info: { kind: "not_found" } });
  });

  it("callBlockReason: nobody else, external, too many; the person alone or with same-tenant people is allowed", () => {
    const m = (self: boolean, external = false) => ({ userId: null, displayName: "x", tenantId: null, external, self });
    expect(callBlockReason([m(true)], false)).toBe("no_one");
    expect(callBlockReason([m(true), m(false)], false)).toBeNull();
    expect(callBlockReason([m(true), m(false), m(false, true)], false)).toBe("external");
    expect(callBlockReason([m(true), ...Array.from({ length: 11 }, () => m(false))], false)).toBe("too_many");
    expect(callBlockReason([m(true), ...Array.from({ length: 10 }, () => m(false))], false)).toBeNull();
    expect(callBlockReason([m(true), m(false)], true)).toBe("too_many");
  });
});

describe("resolveCallTargets (T-284, spec 13)", () => {
  it("a 1:1 chat with a same-tenant member: that person's sign-in name, read with the narrow $select only", async () => {
    const { fake, reader, conn, me } = setup();
    fake.state.membersByChat.set(CHAT, [member(me, "Me"), member(U1, "Pat")]);
    fake.state.upnByUser.set(U1, `Pat.Example@${DOMAIN}`);
    const r = await reader.resolveCallTargets("PKG", conn, asUser, CHAT);
    expect(r).toEqual({ ok: true, upns: [`pat.example@${DOMAIN}`] });
    const users = fake.state.graphRequests.filter((q) => q.path.includes("/users/"));
    expect(users).toHaveLength(1);
    expect(decode(users[0]?.search ?? "")).toEqual({ $select: "userPrincipalName" });
  });

  it("a group of three: both others, in the chat's order", async () => {
    const { fake, reader, conn, me } = setup();
    fake.state.membersByChat.set(CHAT, [member(me, "Me"), member(U1, "A"), member(U2, "B")]);
    fake.state.upnByUser.set(U1, `a@${DOMAIN}`);
    fake.state.upnByUser.set(U2, `b@${DOMAIN}`);
    expect(await reader.resolveCallTargets("PKG", conn, asUser, CHAT)).toEqual({ ok: true, upns: [`a@${DOMAIN}`, `b@${DOMAIN}`] });
  });

  it("an external member: refused, and no other member is resolved", async () => {
    const { fake, reader, conn, me } = setup();
    fake.state.membersByChat.set(CHAT, [member(me, "Me"), member(U1, "A"), member(U2, "Ext", TEAMS_TENANT_B)]);
    expect(await reader.resolveCallTargets("PKG", conn, asUser, CHAT)).toEqual({ ok: false, reason: "external" });
    expect(fake.state.graphRequests.filter((q) => q.path.includes("/users/"))).toHaveLength(0);
  });

  it("a member with no tenant given counts as external", async () => {
    const { fake, reader, conn, me } = setup();
    fake.state.membersByChat.set(CHAT, [member(me, "Me"), { id: "x", displayName: "N", userId: U1, tenantId: null }]);
    expect(await reader.resolveCallTargets("PKG", conn, asUser, CHAT)).toEqual({ ok: false, reason: "external" });
  });

  it("ten others is the most; eleven is refused", async () => {
    const { fake, reader, conn, me } = setup();
    const ids = Array.from({ length: 11 }, (_, i) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`);
    for (const id of ids) fake.state.upnByUser.set(id, `u${id.slice(-3)}@${DOMAIN}`);
    fake.state.membersByChat.set(CHAT, [member(me, "Me"), ...ids.slice(0, 10).map((id) => member(id, "x"))]);
    const ten = await reader.resolveCallTargets("PKG", conn, asUser, CHAT);
    expect(ten.ok && ten.upns).toHaveLength(10);
    fake.state.membersByChat.set(CHAT, [member(me, "Me"), ...ids.map((id) => member(id, "x"))]);
    expect(await reader.resolveCallTargets("PKG", conn, asUser, CHAT)).toEqual({ ok: false, reason: "too_many" });
  });

  it("only the person in the chat: nobody to call", async () => {
    const { fake, reader, conn, me } = setup();
    fake.state.membersByChat.set(CHAT, [member(me, "Me")]);
    expect(await reader.resolveCallTargets("PKG", conn, asUser, CHAT)).toEqual({ ok: false, reason: "no_one" });
  });

  it("a sign-in name that is not one plain address (a comma, ampersand, hash, guest marker, space) is never put in a link", async () => {
    for (const bad of ["a@x.example.test,b@x.example.test", "a&withVideo=true@x.example.test", "a#b@x.example.test", "pat_x.com#EXT#@x.example.test", "a b@x.example.test", "a@x", "", "a=b@x.example.test", "<a>@x.example.test", "a@x.example.test/evil"]) {
      expect(upnOf(bad), bad).toBeNull();
      const { fake, reader, conn, me } = setup();
      fake.state.membersByChat.set(CHAT, [member(me, "Me"), member(U1, "A")]);
      fake.state.upnByUser.set(U1, bad);
      expect(await reader.resolveCallTargets("PKG", conn, asUser, CHAT), bad).toEqual({ ok: false, reason: "unresolved" });
    }
  });

  it("a member id that is not a lower-case user id, or the same member twice, is unresolved before any user read", async () => {
    const { fake, reader, conn, me } = setup();
    fake.state.membersByChat.set(CHAT, [member(me, "Me"), { id: "x", displayName: "N", userId: "not-an-id", tenantId: TEAMS_TENANT_A }]);
    expect(await reader.resolveCallTargets("PKG", conn, asUser, CHAT)).toEqual({ ok: false, reason: "unresolved" });
    fake.state.membersByChat.set(CHAT, [member(me, "Me"), member(U3, "A"), member(U3, "A again")]);
    expect(await reader.resolveCallTargets("PKG", conn, asUser, CHAT)).toEqual({ ok: false, reason: "unresolved" });
    expect(fake.state.graphRequests.filter((q) => q.path.includes("/users/"))).toHaveLength(0);
  });

  it("a connection without the call_links feature is refused by the guard before any read of a user", async () => {
    const lane = setup({ teams: { features: ["chat_read"] } });
    lane.fake.state.membersByChat.set(CHAT, [member(lane.me, "Me"), member(U1, "A")]);
    await expect(lane.reader.resolveCallTargets("PKG", lane.conn, asUser, CHAT)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(lane.fake.state.graphRequests.filter((q) => q.path.includes("/users/"))).toHaveLength(0);
  });
});

describe("T-281 review follow-ups", () => {
  it("SM1: a file link is kept only on a Microsoft file host (dot-boundary suffix); look-alikes, userinfo, a trailing dot and punycode give no link", async () => {
    for (const ok of ["contoso.sharepoint.com", "contoso-my.sharepoint.com", "sharepoint.com", "onedrive.live.com"]) expect(isMicrosoftFileHost(ok), ok).toBe(true);
    for (const bad of ["sharepoint.com.evil.example", "evilsharepoint.com", "sharepoint.com.", "xn--sharepoint-x.com", "live.com", "evil-onedrive.live.com.example", "1drv.ms", "a.1drv.ms", "xn--1drv-ms.example"]) expect(isMicrosoftFileHost(bad), bad).toBe(false);
    const { fake, reader, conn } = setup();
    const urls = ["https://sharepoint.com.evil.example/f", "https://evilsharepoint.com/f", "https://user@contoso.sharepoint.com/f", "https://contoso.sharepoint.com./f", "https://xn--sharepont-q1a.com/f", "https://contoso.sharepoint.com/f"];
    fake.state.messagesByChat.set(CHAT, [msg("m1", "2026-11-21T09:00:00Z", { attachments: urls.map((contentUrl) => ({ contentType: "reference", contentUrl, name: "f.docx" })) })]);
    const r = await reader.listMessages("PKG", conn, asUser, CHAT);
    expect(r.messages[0]?.attachments.map((a) => a.href)).toEqual([null, null, null, null, null, "https://contoso.sharepoint.com/f"]);
    expect(r.messages[0]?.attachments[5]?.host).toBe("contoso.sharepoint.com");
  });

  it("C3: a member with the guest role is external even in the person's own tenant", async () => {
    const { fake, reader, conn, me } = setup();
    fake.state.membersByChat.set(CHAT, [member(me, "Me"), { ...member(U1, "Guest"), roles: ["guest"] }]);
    const m = await reader.listMembers("PKG", conn, asUser, CHAT);
    expect(m.members.map((x) => x.external)).toEqual([false, true]);
    expect(await reader.resolveCallTargets("PKG", conn, asUser, CHAT)).toEqual({ ok: false, reason: "external" });
  });

  it("C4: a system event as the newest preview never leaves a chat unread", () => {
    const base = { hidden: false, lastReadAt: null, preview: { createdAt: "2026-11-21T09:00:00.000Z", senderId: null, senderName: null, mine: false, text: "", deleted: false, system: true } };
    expect(chatIsUnread(base, null)).toBe(false);
  });

  it("C7a: a short page that carries a next link still offers older messages", async () => {
    const { reader, conn } = setup();
    server.use(http.get("https://graph.microsoft.com/v1.0/chats/:id/messages", () => HttpResponse.json({ value: [msg("a", "2026-11-21T09:00:00Z")], "@odata.nextLink": "https://graph.microsoft.com/v1.0/chats/x/messages?$skiptoken=1" })));
    expect((await reader.listMessages("PKG", conn, asUser, CHAT)).nextBefore).toBe("2026-11-21T09:00:00.000Z");
  });

  it("C7b: a chats next link that cannot become a cursor logs one content-free line", async () => {
    const { reader, conn, lines } = setup();
    server.use(http.get("https://graph.microsoft.com/v1.0/me/chats", () => HttpResponse.json({ value: [chat(CHAT, { topic: CANARY })], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/chats?$skip=50" })));
    await reader.listChats("PKG", conn, asUser);
    expect(lines.filter((l) => l.event === "teams.chats.no_cursor")).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });

  it("C7c: a member whose account is gone (404 on the user read) is 'unresolved', not an error", async () => {
    const { fake, reader, conn, me } = setup();
    fake.state.membersByChat.set(CHAT, [member(me, "Me"), member(U1, "A")]);
    server.use(http.get("https://graph.microsoft.com/v1.0/users/:id", () => HttpResponse.json({ error: { code: "Request_ResourceNotFound" } }, { status: 404 })));
    expect(await reader.resolveCallTargets("PKG", conn, asUser, CHAT)).toEqual({ ok: false, reason: "unresolved" });
  });

  it("C7d: page reads ask for a 12 second timeout", async () => {
    const { h, fake, conn } = setup();
    const seen: (number | undefined)[] = [];
    const api = { get: async (l: never, c: never, req: { timeoutMs?: number }) => (seen.push(req.timeoutMs), h.api.get(l, c, req as never)) };
    await createTeamsReader({ api: api as never }).listChats("PKG", conn, asUser);
    expect(seen).toEqual([12_000]);
    expect(fake.state.graphRequests).toHaveLength(1);
  });

  it("C7k: a chat that is gone is not_found, a 400 on messages is invalid_input, an empty chat is an empty page", async () => {
    const { fake, reader, conn } = setup();
    await expect(reader.getChat("PKG", conn, asUser, CHAT)).rejects.toMatchObject({ info: { kind: "not_found" } });
    fake.state.graphFail = { status: 400, code: "BadRequest", times: 1 };
    await expect(reader.listMessages("PKG", conn, asUser, CHAT)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    const r = await reader.listMessages("PKG", conn, asUser, CHAT);
    expect(r).toMatchObject({ messages: [], nextBefore: null });
  });

  it("SL6: names that are blank to the eye are '(no name)'", async () => {
    const { fake, reader, conn, me } = setup();
    fake.state.membersByChat.set(CHAT, [member(me, "Me"), member(U1, "\u3164\u2800\u115f")]);
    expect((await reader.listMembers("PKG", conn, asUser, CHAT)).members[1]?.displayName).toBe("(no name)");
    fake.state.messagesByChat.set(CHAT, [msg("m1", "2026-11-21T09:00:00Z", { from: { user: { id: U1, displayName: "\u180e\u3164" } } })]);
    expect((await reader.listMessages("PKG", conn, asUser, CHAT)).messages[0]?.sender.name).toBe("(no name)");
  });

  it("SL2: the per-chat pacing key holds a short hash, not the chat id (it is logged on every request line)", async () => {
    const { h, reader, conn } = setup();
    await reader.listMessages("PKG", conn, asUser, CHAT);
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain("abc123def456");
  });
});
