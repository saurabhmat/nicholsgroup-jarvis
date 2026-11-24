// Messages: teams, channels, posts and replies as the page draws them (T-291; spec 8, 8.2, 11, 14). Server-only reads, each ONE request, started TOGETHER by the page (the team list, the
// open team's channels, the open channel's posts and the open post's replies never wait for each other):
//   - Graph through `@nichols/connectors/teams-reader` (the guard: the owner, the company's `channels_read` AND the connection's; fixed templates; ids validated before any request);
//   - nothing else: channels have no unread state in Teams, so there is no read marker, no table and nothing stored (rule 6).
// Everything from Teams is fetched live, turned into a view for this response and dropped: no cache, no store, no log line with content. A failure becomes a fixed `TeamsFailure` (never
// Microsoft's text). Rule 9: names and text are untrusted strings that components draw as text; links come out of the reader already checked (https only, teams.microsoft.com for Open in Teams).
import { isConnId } from "./teams-accounts";
import type { LaneId } from "@nichols/core";
import { listChannelPosts, listChannels, listReplies, listTeams } from "@nichols/connectors/teams-reader";
import { openChannelUrl, openPostUrl, type ChannelPost, type ChannelSummary } from "@nichols/connectors/teams-pure";
import { teamsFailure, type TeamsFailure } from "./teams-errors";
import { messageView, type MessageView, type TeamsPerson } from "./teams-chats";
import { encodeChannelKey, isMessageId } from "./teams-channel-key";

export type TeamRowView = { teamId: string; name: string; archived: boolean };
export type TeamListView = { kind: "ok"; teams: TeamRowView[]; more: boolean } | TeamsFailure;

export type ChannelRowView = {
  key: string;
  name: string;
  kind: "standard" | "private" | "shared" | "other";
  /** Only a standard or private channel is read here; a shared one (spec 14) or one of a kind this build does not know is not: opens in Teams (spec 14: reading a shared channel across tenants is not confirmed). */
  readable: boolean;
  openUrl: string;
};
export type ChannelListView = { kind: "ok"; channels: ChannelRowView[] } | TeamsFailure;

export type PostView = MessageView & { subject: string | null; openUrl: string };
/** `shared`: the team's channel list marks the channel shared (or it is not in the list): not read, it opens in Teams (T-291). */
export type ThreadView = { kind: "ok"; posts: PostView[]; nextCursor: string | null } | { kind: "shared"; openUrl: string } | TeamsFailure;
export type RepliesView = { kind: "ok"; postId: string; replies: MessageView[]; more: boolean } | TeamsFailure;

/** The image route's address for a root post of a channel (T-285). Null when an id is not valid. */
export function postImagesBase(laneId: string, teamId: string, channelKey: string, messageId: string, conn: string): string | null {
  // T-295: the image route names the connection (`conn`) in both forms; channels are read through the person's first usable account until T-296 gives each team its own account
  return isMessageId(messageId) && isConnId(conn) ? `/api/lanes/${encodeURIComponent(laneId)}/messages/image?team=${encodeURIComponent(teamId)}&channel=${encodeURIComponent(channelKey)}&conn=${encodeURIComponent(conn)}&message=${encodeURIComponent(messageId)}` : null;
}

export async function loadTeams(p: Omit<TeamsPerson, "client">): Promise<TeamListView> {
  try {
    const r = await listTeams(p.laneId as LaneId, p.connectionId, p.userId);
    return { kind: "ok", teams: r.teams.map((t) => ({ teamId: t.teamId, name: t.name, archived: t.archived })), more: r.more };
  } catch (e) {
    return teamsFailure(e);
  }
}

export function channelRow(c: ChannelSummary): ChannelRowView | null {
  try {
    return { key: encodeChannelKey(c.channelId), name: c.name, kind: c.kind, readable: c.kind === "standard" || c.kind === "private", openUrl: openChannelUrl(c.webUrl) };
  } catch {
    return null; // an id the page cannot encode is not shown
  }
}

export async function loadChannels(p: Omit<TeamsPerson, "client">, teamId: string): Promise<ChannelListView> {
  try {
    const r = await listChannels(p.laneId as LaneId, p.connectionId, p.userId, teamId);
    return { kind: "ok", channels: r.channels.flatMap((c) => channelRow(c) ?? []) };
  } catch (e) {
    return teamsFailure(e);
  }
}

function postView(laneId: string, conn: string, teamId: string, channelKey: string, tenantId: string, channelId: string, post: ChannelPost): PostView {
  let openUrl: string;
  try {
    openUrl = openPostUrl({ webUrl: post.webUrl, channelId, messageId: post.id, teamId, tenantId });
  } catch {
    openUrl = openChannelUrl(null); // an id the link cannot carry: Teams itself
  }
  return { ...messageView(post, postImagesBase(laneId, teamId, channelKey, post.id, conn)), subject: post.subject, openUrl };
}

/** A page of a channel's root posts, in Graph's order (the thread with the newest activity first). System events are not drawn. */
export async function loadThread(p: Omit<TeamsPerson, "client">, teamId: string, channelId: string, opts: { cursor?: string } = {}): Promise<ThreadView> {
  try {
    const r = await listChannelPosts(p.laneId as LaneId, p.connectionId, p.userId, teamId, channelId, opts.cursor ? { cursor: opts.cursor } : {});
    const key = encodeChannelKey(channelId);
    return { kind: "ok", posts: r.posts.filter((m) => !m.system).map((m) => postView(p.laneId, p.connectionId, teamId, key, r.self.tenantId, channelId, m)), nextCursor: r.nextCursor };
  } catch (e) {
    return teamsFailure(e);
  }
}

/** The replies of one post, oldest first. Pictures in a reply are placeholders (no address names a hosted content of a reply in the fact sheet). */
export async function loadReplies(p: Omit<TeamsPerson, "client">, teamId: string, channelId: string, postId: string): Promise<RepliesView> {
  try {
    const r = await listReplies(p.laneId as LaneId, p.connectionId, p.userId, teamId, channelId, postId);
    return { kind: "ok", postId, replies: r.replies.filter((m) => !m.system).map((m) => messageView(m, null)), more: r.more };
  } catch (e) {
    return teamsFailure(e);
  }
}

/**
 * Decides, from the team's channel list, whether a channel's posts may be read at all (L1): a shared channel is never read (it opens in Teams), a channel that is not in the list is "not found"
 * without asking Microsoft, and a failed list is that failure. `ok` means "read it".
 */
export function gateChannel(list: ChannelListView, key: string): { ok: true } | { ok: false; view: ThreadView } {
  if (list.kind !== "ok") return { ok: false, view: list };
  const c = list.channels.find((x) => x.key === key);
  if (!c) return { ok: false, view: { kind: "not_found" } };
  if (!c.readable) return { ok: false, view: { kind: "shared", openUrl: c.openUrl } };
  return { ok: true };
}
