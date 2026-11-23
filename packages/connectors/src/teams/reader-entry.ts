import "server-only";
// `@nichols/connectors/teams-reader` (T-281, T-283, T-284): the narrow surface the Messages page and its routes need to READ the signed-in person's own Teams chats, and nothing else.
// apps/web does not import the Teams package as a whole (it holds the guarded Graph client, the health check and the disconnect). Server-only. Every function takes the lane, the Teams
// connection id and the SIGNED-IN person's id: the guard refuses a connection whose owner is anyone else (an admin included) before a token is read, and nothing here can write to Microsoft.
// Rule 6: what these return is for the one request that asked; nothing is stored, cached or logged here.
import type { LaneId } from "@nichols/core";
import { connectionLoader } from "../vault/index";
import { teamsChannelReader, teamsImageReader, teamsReader } from "./index";
import type { ChannelList, PostPage, ReplyPage, TeamList } from "./channels";
import type { HostedTarget } from "./hosted-content";
import type { HostedImage } from "./images";
import type { CallTargets, ChatList, MessagePage, TeamsChat, TeamsMember } from "./reader";

// The pure parts (types, the unread and call rules, the deep-link builders, the message converter) are `@nichols/connectors/teams-pure`: no server-only import, so components can use them.

const load = (laneId: LaneId, connectionId: string) => connectionLoader.loadConnection(laneId, connectionId);

export async function listChats(laneId: LaneId, connectionId: string, userId: string, opts: { cursor?: string } = {}): Promise<ChatList> {
  return teamsReader.listChats(laneId, await load(laneId, connectionId), userId, opts);
}

export async function listMessages(laneId: LaneId, connectionId: string, userId: string, chatId: string, opts: { before?: string; sinceModified?: string } = {}): Promise<MessagePage> {
  return teamsReader.listMessages(laneId, await load(laneId, connectionId), userId, chatId, opts);
}

/** One chat's topic, type and link, and its members: two reads started together. */
export async function openChat(laneId: LaneId, connectionId: string, userId: string, chatId: string): Promise<{ chat: TeamsChat | null; members: TeamsMember[]; membersMore: boolean }> {
  const conn = await load(laneId, connectionId);
  const [c, m] = await Promise.all([teamsReader.getChat(laneId, conn, userId, chatId), teamsReader.listMembers(laneId, conn, userId, chatId)]);
  return { chat: c.chat, members: m.members, membersMore: m.more };
}

export async function resolveCallTargets(laneId: LaneId, connectionId: string, userId: string, chatId: string): Promise<CallTargets> {
  return teamsReader.resolveCallTargets(laneId, await load(laneId, connectionId), userId, chatId);
}

// ---- T-291: channels (read only; the guard needs `channels_read` on the company AND on the connection)
export async function listTeams(laneId: LaneId, connectionId: string, userId: string): Promise<TeamList> {
  return teamsChannelReader.listTeams(laneId, await load(laneId, connectionId), userId);
}

export async function listChannels(laneId: LaneId, connectionId: string, userId: string, teamId: string): Promise<ChannelList> {
  return teamsChannelReader.listChannels(laneId, await load(laneId, connectionId), userId, teamId);
}

export async function listChannelPosts(laneId: LaneId, connectionId: string, userId: string, teamId: string, channelId: string, opts: { cursor?: string } = {}): Promise<PostPage> {
  return teamsChannelReader.listChannelPosts(laneId, await load(laneId, connectionId), userId, teamId, channelId, opts);
}

export async function listReplies(laneId: LaneId, connectionId: string, userId: string, teamId: string, channelId: string, messageId: string): Promise<ReplyPage> {
  return teamsChannelReader.listReplies(laneId, await load(laneId, connectionId), userId, teamId, channelId, messageId);
}

// ---- T-285: the bytes of one inline image (the portal's own image route only)
export async function fetchHostedImage(laneId: LaneId, connectionId: string, userId: string, target: HostedTarget, signal?: AbortSignal): Promise<HostedImage> {
  return teamsImageReader.fetchHostedImage(laneId, await load(laneId, connectionId), userId, target, signal);
}
