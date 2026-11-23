// Teams, channels, posts and replies as the page draws them (T-291): the views the loaders build, failures as fixed states, the same-site image address of a post, Open in Teams links, and the privacy
// rule (a canary in every name, subject and body never reaches a log). The Teams reader is faked (its own tests are in packages/connectors).
import { beforeEach, describe, expect, it, vi } from "vitest";

const reader = vi.hoisted(() => ({ listTeams: vi.fn(), listChannels: vi.fn(), listChannelPosts: vi.fn(), listReplies: vi.fn() }));
vi.mock("@nichols/connectors/teams-reader", () => ({ ...reader }));

import { channelRow, loadChannels, loadReplies, loadTeams, loadThread, postImagesBase } from "./teams-channels";
import { encodeChannelKey } from "./teams-channel-key";

const CANARY = "canary-channel-view-3c7e-not-real";
const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1";
const TENANT = "11111111-1111-4111-8111-111111111111";
const CH = "19:general111@thread.tacv2";
const KEY = encodeChannelKey(CH);
const ME = "00000000-0000-4000-8000-0000000000a1";
const person = { laneId: "PKG", userId: ME, connectionId: "00000000-0000-4000-8000-0000000000c1" };
const self = { tenantId: TENANT, entraObjectId: ME };
const post = (id: string, over: Record<string, unknown> = {}) => ({
  id, createdAt: "2026-11-23T14:05:00.000Z", modifiedAt: null, edited: false, deleted: false, system: false, sender: { id: null, name: "Pat", kind: "user" }, mine: false,
  nodes: [{ t: "text", v: `post ${id}` }], truncated: false, attachments: [], subject: null, webUrl: null, ...over,
});

beforeEach(() => {
  for (const f of Object.values(reader)) f.mockReset();
});

describe("teams and channels", () => {
  it("teams: ids and names only", async () => {
    reader.listTeams.mockResolvedValue({ teams: [{ teamId: TEAM, name: "Alpha" }], more: true, self });
    expect(await loadTeams(person)).toEqual({ kind: "ok", teams: [{ teamId: TEAM, name: "Alpha" }], more: true });
    expect(reader.listTeams).toHaveBeenCalledWith("PKG", person.connectionId, ME);
  });

  it("channels: kinds, the shared channel is not readable and opens in Teams, links only on teams.microsoft.com", async () => {
    reader.listChannels.mockResolvedValue({
      channels: [
        { channelId: CH, name: "General", kind: "standard", webUrl: "https://teams.microsoft.com/l/channel/x" },
        { channelId: "19:priv@thread.tacv2", name: "Leads", kind: "private", webUrl: null },
        { channelId: "19:shared@thread.tacv2", name: "Partners", kind: "shared", webUrl: null },
        { channelId: "not a channel id", name: "bad", kind: "standard", webUrl: null },
      ],
      self,
    });
    const v = await loadChannels(person, TEAM);
    expect(v.kind === "ok" && v.channels.map((c) => [c.name, c.kind, c.readable, c.openUrl])).toEqual([
      ["General", "standard", true, "https://teams.microsoft.com/l/channel/x"],
      ["Leads", "private", true, "https://teams.microsoft.com"],
      ["Partners", "shared", false, "https://teams.microsoft.com"],
    ]);
    expect(reader.listChannels).toHaveBeenCalledWith("PKG", person.connectionId, ME, TEAM);
    expect(channelRow({ channelId: CH, name: "x", kind: "standard", webUrl: "https://evil.example.test/x" })?.openUrl).toBe("https://teams.microsoft.com");
  });

  it("a Graph failure is a fixed state, never an empty list, and carries nothing from the error", async () => {
    for (const [info, want] of [
      [{ kind: "rate_limited", retry_after_seconds: 9 }, { kind: "busy", seconds: 9 }],
      [{ kind: "reconnect_required" }, { kind: "reconnect" }],
      [{ kind: "forbidden" }, { kind: "forbidden" }],
      [{ kind: "not_found" }, { kind: "not_found" }],
      [{ kind: "timeout" }, { kind: "unavailable" }],
    ] as const) {
      reader.listTeams.mockRejectedValue({ info: { ...info, message: `secret ${CANARY}` } });
      reader.listChannels.mockRejectedValue({ info: { ...info, message: `secret ${CANARY}` } });
      reader.listChannelPosts.mockRejectedValue({ info: { ...info, message: `secret ${CANARY}` } });
      reader.listReplies.mockRejectedValue({ info: { ...info, message: `secret ${CANARY}` } });
      for (const v of [await loadTeams(person), await loadChannels(person, TEAM), await loadThread(person, TEAM, CH), await loadReplies(person, TEAM, CH, "p1")]) {
        expect(v).toEqual(want);
        expect(JSON.stringify(v)).not.toContain(CANARY);
      }
    }
  });
});

describe("posts and replies", () => {
  it("posts keep Graph's order; system events are not drawn; each carries its subject, its own image address and an Open in Teams link; the cursor is passed on", async () => {
    reader.listChannelPosts.mockResolvedValue({
      posts: [post("1700000000002", { subject: "Budget" }), post("1700000000001", { webUrl: "https://teams.microsoft.com/l/message/x/1" }), post("sys", { system: true }), post("bad id/with slash")],
      nextCursor: "cur1",
      self,
    });
    const v = await loadThread(person, TEAM, CH, { cursor: "cur0" });
    expect(reader.listChannelPosts).toHaveBeenCalledWith("PKG", person.connectionId, ME, TEAM, CH, { cursor: "cur0" });
    if (v.kind !== "ok") throw new Error("ok expected");
    expect(v.nextCursor).toBe("cur1");
    expect(v.posts.map((p) => [p.id, p.subject])).toEqual([["1700000000002", "Budget"], ["1700000000001", null], ["bad id/with slash", null]]);
    expect(v.posts[0]?.images).toBe(`/api/lanes/PKG/messages/image?team=${TEAM}&channel=${KEY}&message=1700000000002`);
    expect(v.posts[2]?.images).toBeNull();
    expect(v.posts[0]?.openUrl).toBe(`https://teams.microsoft.com/l/message/${CH}/1700000000002?tenantId=${TENANT}&groupId=${TEAM}&parentMessageId=1700000000002`);
    expect(v.posts[1]?.openUrl).toBe("https://teams.microsoft.com/l/message/x/1");
    // an id the deep link cannot carry opens Teams itself, never a broken link
    expect(v.posts[2]?.openUrl).toBe("https://teams.microsoft.com");
    reader.listChannelPosts.mockClear();
    await loadThread(person, TEAM, CH);
    expect(reader.listChannelPosts).toHaveBeenCalledWith("PKG", person.connectionId, ME, TEAM, CH, {});
  });

  it("replies: oldest first as the reader returns them, no system events, no image address (pictures in replies are placeholders)", async () => {
    reader.listReplies.mockResolvedValue({ replies: [post("r1"), post("sys", { system: true }), post("r2")], more: true, self });
    const v = await loadReplies(person, TEAM, CH, "p1");
    expect(reader.listReplies).toHaveBeenCalledWith("PKG", person.connectionId, ME, TEAM, CH, "p1");
    expect(v.kind === "ok" && [v.postId, v.more, v.replies.map((r) => [r.id, r.images])]).toEqual(["p1", true, [["r1", null], ["r2", null]]]);
  });

  it("the image address helper validates the message id and encodes the others", () => {
    expect(postImagesBase("PKG", TEAM, KEY, "1700000000001")).toBe(`/api/lanes/PKG/messages/image?team=${TEAM}&channel=${KEY}&message=1700000000001`);
    for (const bad of ["", "..", "a/b", "a b", "x".repeat(300)]) expect(postImagesBase("PKG", TEAM, KEY, bad), bad).toBeNull();
  });

  it("rule 6: a canary in names, subjects and bodies never reaches a log line", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")].map((s) => s.mockImplementation(() => undefined));
    reader.listTeams.mockResolvedValue({ teams: [{ teamId: TEAM, name: CANARY }], more: false, self });
    reader.listChannels.mockResolvedValue({ channels: [{ channelId: CH, name: CANARY, kind: "standard", webUrl: null }], self });
    reader.listChannelPosts.mockResolvedValue({ posts: [post("p1", { subject: CANARY, nodes: [{ t: "text", v: CANARY }] })], nextCursor: null, self });
    reader.listReplies.mockResolvedValue({ replies: [post("r1", { nodes: [{ t: "text", v: CANARY }] })], more: false, self });
    await Promise.all([loadTeams(person), loadChannels(person, TEAM), loadThread(person, TEAM, CH), loadReplies(person, TEAM, CH, "p1")]);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(CANARY);
    vi.restoreAllMocks();
  });

  it("teams, channels, posts and replies are STARTED together by the page: the loaders do not wait for each other", async () => {
    const order: string[] = [];
    reader.listTeams.mockImplementation(async () => (order.push("teams"), { teams: [], more: false, self }));
    reader.listChannels.mockImplementation(async () => (order.push("channels"), { channels: [], self }));
    reader.listChannelPosts.mockImplementation(async () => (order.push("posts"), { posts: [], nextCursor: null, self }));
    reader.listReplies.mockImplementation(async () => (order.push("replies"), { replies: [], more: false, self }));
    await Promise.all([loadTeams(person), loadChannels(person, TEAM), loadThread(person, TEAM, CH), loadReplies(person, TEAM, CH, "p1")]);
    expect(order.sort()).toEqual(["channels", "posts", "replies", "teams"]);
  });
});
