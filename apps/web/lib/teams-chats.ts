// Messages: the chat list and a conversation as the page draws them (T-283, T-284; spec 8.1, 11, 13). Server-only reads, ONE request each:
//   - the chat list: Graph (through `@nichols/connectors/teams-reader`: the guard, the owner check, fixed templates) and the portal's own read markers (the person's own lane client), started TOGETHER;
//   - a conversation: the chat, its members and its newest messages, started together.
// Rule 6: everything from Teams is fetched live, turned into a view for this response and dropped: no cache, no store, no log line with content. A failure becomes a fixed `TeamsFailure`
// (never Microsoft's text). Rule 9: names and text are untrusted strings that the components draw as text; links come out of the reader already checked (https only).
// Nothing here writes to Microsoft; the only write is the person's own read marker (their own lane client, in teams-api.ts).
import type { LaneId } from "@nichols/core";
import type { LaneClient } from "@nichols/core/lane-router";
import { listChats, listMessages, openChat } from "@nichols/connectors/teams-reader";
import { callBlockReason, chatIsUnread, openChatUrl, type ChatMessage, type MessageNode, type TeamsChat, type TeamsMember } from "@nichols/connectors/teams-pure";
import { teamsFailure, type TeamsFailure } from "./teams-errors";
import { clockTime, dayKey, fullTime, listTime } from "./teams-format";
import { encodeChatKey } from "./teams-chat-key";
import { readMarkers } from "./teams-reads";

export type ChatRowView = {
  key: string;
  title: string;
  /** One line: "You: ...", "Name: ..." in a group, or the text. Cut at 160 characters by the reader. */
  preview: string;
  time: string;
  unread: boolean;
  external: boolean;
};
export type ChatListView = { kind: "ok"; rows: ChatRowView[]; moreCursor: string | null } | TeamsFailure;

export type AttachmentView = { kind: "file" | "reply" | "card" | "other"; name: string; href: string | null };
export type MessageView = {
  id: string;
  /** ISO time (Microsoft's clock). */
  at: string;
  time: string;
  fullTime: string;
  day: string;
  sender: string | null;
  mine: boolean;
  edited: boolean;
  deleted: boolean;
  system: boolean;
  nodes: MessageNode[];
  truncated: boolean;
  attachments: AttachmentView[];
};
export type CallState = "available" | "external" | "too_many" | "no_one" | "off_lane" | "needs_reconnect";
export type ConversationView =
  | {
      kind: "ok";
      chatKey: string;
      title: string;
      /** "3 people", "2 people, one external". */
      subtitle: string;
      external: boolean;
      /** More than one other person: sender names are drawn on each message. */
      group: boolean;
      /** Open in Teams: always https on teams.microsoft.com. */
      openUrl: string;
      call: CallState;
      /** Oldest first. */
      messages: MessageView[];
      /** Ask "older than" this next; null: this is the start of the chat. */
      nextBefore: string | null;
      /** The newest message shown: what opening the chat records as read. */
      readThrough: string | null;
    }
  | TeamsFailure;

type Db = Pick<LaneClient, "schema">;
export type TeamsPerson = { laneId: string; userId: string; connectionId: string; client: Db };

const OTHER_NAMES = 3;

/** The chat's title: its topic, else the other people's names ("A, B +2"), else "Chat". */
export function chatTitle(chat: Pick<TeamsChat, "topic" | "members">): string {
  if (chat.topic) return chat.topic;
  const others = chat.members.filter((m) => !m.self && m.displayName !== "");
  if (others.length === 0) return "Chat";
  const shown = others.slice(0, OTHER_NAMES).map((m) => m.displayName).join(", ");
  return others.length > OTHER_NAMES ? `${shown} +${String(others.length - OTHER_NAMES)}` : shown;
}

function previewLine(chat: TeamsChat): string {
  const p = chat.preview;
  if (!p) return "";
  if (p.system) return "Teams event";
  if (p.deleted) return "This message was deleted";
  const text = p.text === "" ? "Message" : p.text;
  if (p.mine) return `You: ${text}`;
  return chat.chatType === "group" && p.senderName ? `${p.senderName}: ${text}` : text;
}

export function chatRow(chat: TeamsChat, portalReadThrough: string | null, selected: boolean, nowMs: number): ChatRowView {
  return {
    key: encodeChatKey(chat.chatId),
    title: chatTitle(chat),
    preview: previewLine(chat),
    time: chat.preview ? listTime(chat.preview.createdAt, nowMs) : "",
    // the chat being read right now is not unread (its marker is written when it opens)
    unread: !selected && chatIsUnread(chat, portalReadThrough),
    external: chat.members.some((m) => m.external),
  };
}

/** The first page of chats, or the page after `cursor` (an explicit "More chats"). Graph and the markers are read together. */
export async function loadChatList(p: TeamsPerson, opts: { cursor?: string; selectedKey?: string | null }): Promise<ChatListView> {
  try {
    const [list, markers] = await Promise.all([listChats(p.laneId as LaneId, p.connectionId, p.userId, opts.cursor ? { cursor: opts.cursor } : {}), readMarkers(p.client, p.laneId, p.connectionId)]);
    const now = Date.now(); // after the data: the page's clock is read only once there is data to show
    const rows = list.chats.flatMap((c) => {
      try {
        return [chatRow(c, markers.get(c.chatId) ?? null, encodeChatKey(c.chatId) === opts.selectedKey, now)];
      } catch {
        return []; // an id the page cannot encode is not shown
      }
    });
    return { kind: "ok", rows, moreCursor: list.nextCursor };
  } catch (e) {
    return teamsFailure(e);
  }
}

function subtitleOf(members: readonly TeamsMember[], more: boolean): { text: string; external: boolean } {
  const others = members.filter((m) => !m.self);
  const external = others.some((m) => m.external);
  const total = members.length;
  const people = more ? `${String(total)}+ people` : total === 1 ? "1 person" : `${String(total)} people`;
  return { text: external ? `${people}, includes external people` : people, external };
}

export function messageView(m: ChatMessage): MessageView {
  return {
    id: m.id,
    at: m.createdAt,
    time: clockTime(m.createdAt),
    fullTime: fullTime(m.createdAt),
    day: dayKey(m.createdAt),
    sender: m.sender.name,
    mine: m.mine,
    edited: m.edited,
    deleted: m.deleted,
    system: m.system,
    nodes: m.nodes,
    truncated: m.truncated,
    attachments: m.attachments.map((a) => ({ kind: a.kind, name: a.name, href: a.href })),
  };
}

export type CallPolicy = { laneListsCalls: boolean; connectionHasCalls: boolean };

/** One conversation: the chat, its members and its newest messages. Messages are shown oldest first. */
export async function loadConversation(p: TeamsPerson, chatId: string, chatKey: string, policy: CallPolicy): Promise<ConversationView> {
  try {
    const [chat, page] = await Promise.all([openChat(p.laneId as LaneId, p.connectionId, p.userId, chatId), listMessages(p.laneId as LaneId, p.connectionId, p.userId, chatId)]);
    if (!chat.chat) return { kind: "not_found" };
    const members = chat.members;
    const sub = subtitleOf(members, chat.membersMore);
    const blocked = callBlockReason(members, chat.membersMore);
    let call: CallState = "available";
    if (blocked !== null) call = blocked;
    else if (!policy.laneListsCalls) call = "off_lane";
    else if (!policy.connectionHasCalls) call = "needs_reconnect";
    const messages = [...page.messages].reverse().map(messageView);
    return {
      kind: "ok",
      chatKey,
      title: chatTitle({ topic: chat.chat.topic, members }),
      subtitle: sub.text,
      external: sub.external,
      group: members.filter((m) => !m.self).length > 1,
      openUrl: openChatUrl(chatId, chat.chat.webUrl),
      call,
      messages,
      nextBefore: page.nextBefore,
      readThrough: messages.length > 0 ? (messages[messages.length - 1] as MessageView).at : null,
    };
  } catch (e) {
    return teamsFailure(e);
  }
}

/** A page of older messages for "Load older messages" (an explicit action). Oldest first. */
export async function loadOlder(p: Omit<TeamsPerson, "client">, chatId: string, before: string): Promise<{ kind: "ok"; messages: MessageView[]; nextBefore: string | null } | TeamsFailure> {
  try {
    const page = await listMessages(p.laneId as LaneId, p.connectionId, p.userId, chatId, { before });
    return { kind: "ok", messages: [...page.messages].reverse().map(messageView), nextBefore: page.nextBefore };
  } catch (e) {
    return teamsFailure(e);
  }
}

