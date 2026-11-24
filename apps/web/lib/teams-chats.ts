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
import { decodeChatKey, encodeChatKey } from "./teams-chat-key";
import { isMessageId } from "./teams-channel-key";
import { readMarkersMany } from "./teams-reads";
import { isConnId } from "./teams-accounts";
import { compareRows } from "./teams-row-order";
import { decodeCursor, encodeCursor, SOURCE_TOKEN } from "./teams-cursor";

export type ChatRowView = {
  key: string;
  /**
   * The connection (account) this row belongs to: a row is always one (account, chat) pair, keyed by `(conn, key)`, never by the chat alone (T-295, D-70: a chat both accounts are in is two rows).
   * The connection id is the person's own and carries no content.
   */
  conn: string;
  /** The account label ("pubkgroup.com") when the person has two or more usable accounts; null otherwise (the page then looks as it always did). */
  account: string | null;
  /** The account's full sign-in name: the badge's accessible name ("Account: <name>"). Null when `account` is null. */
  accountName: string | null;
  /** Microsoft's time of the newest message (ISO), for ordering rows of several accounts in the browser; null with no preview. Not drawn. */
  at: string | null;
  /** The order the accounts were connected in: the last tie-break of the merge. Not drawn. */
  ord: number;
  title: string;
  /** One line: "You: ...", "Name: ..." in a group, or the text. Cut at 160 characters by the reader. */
  preview: string;
  time: string;
  unread: boolean;
  external: boolean;
};
/** One plain line above the list for an account that did not answer (T-295, spec 22.5): never an empty list without a reason. */
export type AccountNote = { conn: string; label: string; kind: "reconnect" | "busy" | "unreachable"; seconds: number | null };
export type ChatListView =
  | {
      kind: "ok";
      rows: ChatRowView[];
      moreCursor: string | null;
      /** Accounts that did not answer (several accounts only). */
      notes?: AccountNote[];
      /** The accounts whose list was read: the page marks only these as seen (an account that failed keeps its dot). */
      listed?: string[];
      /** A cursor entry named an account that is not (or no longer) one of the person's usable ones: it was dropped (spec 22.5). */
      dropped?: boolean;
    }
  | (TeamsFailure & { notes?: AccountNote[] });

export type AttachmentView = { kind: "file" | "reply" | "card" | "other"; name: string; href: string | null; /** The link's host, drawn beside it. */ host: string | null };
export type MessageView = {
  id: string;
  /**
   * The same-site address a picture of THIS message is drawn from (T-285), without the hosted-content id the node carries: `/api/lanes/<lane>/messages/image?chat=<key>&message=<id>` (or `team=`,
   * `channel=`). Built here from validated values; never an address from Teams. Null: no message address (every picture is a placeholder).
   */
  images: string | null;
  /** ISO time (Microsoft's clock). */
  at: string;
  /** `lastModifiedDateTime` (Microsoft's clock), or null: of two copies of one message the later one wins when pages are merged. */
  modifiedAt?: string | null;
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
      /** The connection (account) the conversation is read as: every request of the open conversation names it (T-295). */
      conn: string;
      /** The account label, only when the person has two or more usable accounts; `accountName` is its full sign-in name (the badge's accessible name). */
      account: string | null;
      accountName: string | null;
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
export function chatTitle(chat: Pick<TeamsChat, "topic" | "members"> & { membersCapped?: boolean }): string {
  if (chat.topic) return chat.topic;
  const others = chat.members.filter((m) => !m.self && m.displayName !== "");
  if (others.length === 0) return "Chat";
  const shown = others.slice(0, OTHER_NAMES).map((m) => m.displayName).join(", ");
  // Graph returns at most 25 members with the list: past that the count is unknown, so say "and others" instead of a wrong number (C6)
  if (chat.membersCapped) return `${shown} and others`;
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

export type ChatSource = { connectionId: string; /** The label drawn on rows; null with one usable account. */ label: string | null; /** The full sign-in name. */ account: string; /** The order the accounts were connected in. */ ord: number };

export function chatRow(chat: TeamsChat, portalReadThrough: string | null, selected: boolean, nowMs: number, source: ChatSource): ChatRowView {
  return {
    key: encodeChatKey(chat.chatId),
    conn: source.connectionId,
    account: source.label,
    accountName: source.label === null ? null : source.account,
    at: chat.preview?.createdAt ?? null,
    ord: source.ord,
    title: chatTitle(chat),
    preview: previewLine(chat),
    time: chat.preview ? listTime(chat.preview.createdAt, nowMs) : "",
    // the chat being read right now is not unread (its marker is written when it opens)
    unread: !selected && chatIsUnread(chat, portalReadThrough),
    external: chat.members.some((m) => m.external),
  };
}

/** The member reads a page view may spend when Graph refuses the combined expand: 20 in all, split across the sources in list order (the first ones get the remainder). */
export function splitMemberBudget(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}
export const PAGE_MEMBER_READS = 20;

type Settled = { source: ChatSource; list: PromiseSettledResult<Awaited<ReturnType<typeof listChats>>> };
const noteOf = (source: ChatSource, f: TeamsFailure): AccountNote => ({
  conn: source.connectionId,
  label: source.label ?? source.account,
  kind: f.kind === "reconnect" ? "reconnect" : f.kind === "busy" ? "busy" : "unreachable",
  seconds: f.kind === "busy" ? f.seconds : null,
});

/**
 * The chat list of ALL of the person's usable accounts as one list (T-295; spec 22.5): one `listChats` per source, started TOGETHER with the person's markers (ONE database query for every account), each
 * source its own result ("all settled"). `cursor` is the combined cursor of lib/teams-cursor.ts (the sources it names are re-checked against `sources`: an entry that fails is dropped), or, for a
 * person with ONE source, an old single skip token. Rows of the accounts that answered are merged by preview time; an account that did not answer gets a one-line note. Only when EVERY source fails is
 * the failure of the first one returned (the existing failure card). With one source this is exactly the single-account list it always was.
 */
export async function loadChatLists(
  p: { laneId: string; userId: string; client: Db },
  sources: readonly ChatSource[],
  opts: { cursor?: string | null; selectedKey?: string | null; selectedConn?: string | null },
): Promise<ChatListView> {
  try {
    // which sources to read, and from where
    let plan: { source: ChatSource; token: string | null }[] = sources.map((source) => ({ source, token: null }));
    let dropped = false;
    if (opts.cursor) {
      const entries = decodeCursor(opts.cursor);
      if (entries !== null) {
        const byId = new Map(sources.map((s) => [s.connectionId, s]));
        const kept = entries.flatMap((e) => {
          const source = byId.get(e.conn);
          if (!source) {
            dropped = true;
            return [];
          }
          return e.token === "" ? [] : [{ source, token: e.token }]; // an entry with no more pages is not read again
        });
        plan = kept;
      } else if (sources.length === 1 && SOURCE_TOKEN.test(opts.cursor)) {
        plan = [{ source: sources[0] as ChatSource, token: opts.cursor }]; // an old single-account address keeps working
      }
      // anything else is not a cursor: the newest chats
    }
    const budgets = splitMemberBudget(PAGE_MEMBER_READS, plan.length);
    // L1: the portal's own markers are only a refinement (Graph's own `viewpoint` still drives unread): a markers failure (a database not yet migrated, an outage) must not hide every chat list
    const markersOf = readMarkersMany(p.client, p.laneId, sources.map((s) => s.connectionId)).catch(() => {
      console.warn("[teams-chats] portal read markers unavailable; unread uses Teams' own read time only"); // fixed text: nothing about a chat, an account or a database message
      return new Map<string, Map<string, string>>();
    });
    const [settled, markers] = await Promise.all([
      Promise.all(
        plan.map(
          async ({ source, token }, i): Promise<Settled> => ({
            source,
            list: await listChats(p.laneId as LaneId, source.connectionId, p.userId, { ...(token !== null ? { cursor: token } : {}), memberReads: budgets[i] ?? PAGE_MEMBER_READS }).then(
              (value) => ({ status: "fulfilled" as const, value }),
              (reason: unknown) => ({ status: "rejected" as const, reason }),
            ),
          }),
        ),
      ),
      markersOf,
    ]);
    const failures = settled.flatMap((s) => (s.list.status === "rejected" ? [{ source: s.source, failure: teamsFailure(s.list.reason) }] : []));
    if (plan.length > 0 && failures.length === plan.length) {
      const notes = sources.length > 1 ? failures.map((f) => noteOf(f.source, f.failure)) : undefined;
      return { ...(failures[0] as { failure: TeamsFailure }).failure, ...(notes ? { notes } : {}) };
    }
    const now = Date.now(); // after the data: the page's clock is read only once there is data to show
    const rows: ChatRowView[] = [];
    const next: { conn: string; token: string | null }[] = [];
    for (const s of settled) {
      if (s.list.status !== "fulfilled") {
        // M2: a source that failed on a later page stays in the cursor with the token it was asked with, so the next read retries it (a failed first page has no token: Refresh reads it from the start)
        const asked = plan.find((x) => x.source.connectionId === s.source.connectionId)?.token ?? null;
        if (asked !== null) next.push({ conn: s.source.connectionId, token: asked });
        continue;
      }
      const m = markers.get(s.source.connectionId) ?? new Map<string, string>();
      for (const c of s.list.value.chats) {
        try {
          rows.push(chatRow(c, m.get(c.chatId) ?? null, encodeChatKey(c.chatId) === opts.selectedKey && (opts.selectedConn != null ? s.source.connectionId === opts.selectedConn : sources.length === 1), now, s.source));
        } catch {
          // an id the page cannot encode is not shown
        }
      }
      next.push({ conn: s.source.connectionId, token: s.list.value.nextCursor });
    }
    if (plan.length > 1) rows.sort(compareRows); // one source keeps Graph's own order exactly
    const moreCursor = encodeCursor(next);
    const notes = failures.map((f) => noteOf(f.source, f.failure));
    const listed = settled.flatMap((s) => (s.list.status === "fulfilled" ? [s.source.connectionId] : []));
    return { kind: "ok", rows, moreCursor, ...(notes.length > 0 ? { notes } : {}), listed, ...(dropped ? { dropped: true } : {}) };
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

/** The image route's address for a message of a chat. The ids are validated (a chat id by its key, the message id by the connector's format), then encoded. */
export function chatImagesBase(laneId: string, chatKey: string, messageId: string, conn: string): string | null {
  return isMessageId(messageId) && decodeChatKey(chatKey) !== null && isConnId(conn) ? `/api/lanes/${encodeURIComponent(laneId)}/messages/image?chat=${encodeURIComponent(chatKey)}&conn=${encodeURIComponent(conn)}&message=${encodeURIComponent(messageId)}` : null;
}

export function messageView(m: ChatMessage, images: string | null = null): MessageView {
  return {
    id: m.id,
    images,
    at: m.createdAt,
    modifiedAt: m.modifiedAt,
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
    attachments: m.attachments.map((a) => ({ kind: a.kind, name: a.name, href: a.href, host: a.host })),
  };
}

export type CallPolicy = { laneListsCalls: boolean; connectionHasCalls: boolean };

/** One conversation: the chat, its members and its newest messages. Messages are shown oldest first. */
export async function loadConversation(p: TeamsPerson, chatId: string, chatKey: string, policy: CallPolicy, account: { label: string | null; name: string } = { label: null, name: "" }): Promise<ConversationView> {
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
    // Events that are not a person's message are not drawn (C4) but still count: the newest item of any kind is what opening the chat marks as read
    const messages = [...page.messages].filter((m) => !m.system).reverse().map((m) => messageView(m, chatImagesBase(p.laneId, chatKey, m.id, p.connectionId)));
    const newestAny = page.messages.reduce<string | null>((a, m) => (a === null || m.createdAt > a ? m.createdAt : a), null);
    return {
      kind: "ok",
      chatKey,
      conn: p.connectionId,
      account: account.label,
      accountName: account.label === null ? null : account.name,
      title: chatTitle({ topic: chat.chat.topic, members, membersCapped: chat.membersMore }),
      subtitle: sub.text,
      external: sub.external,
      group: members.filter((m) => !m.self).length > 1,
      openUrl: openChatUrl(chatId, chat.chat.webUrl),
      call,
      messages,
      nextBefore: page.nextBefore,
      readThrough: newestAny,
    };
  } catch (e) {
    return teamsFailure(e);
  }
}

/** A page of older messages for "Load older messages" (an explicit action). Oldest first. */
export async function loadOlder(p: Omit<TeamsPerson, "client">, chatId: string, before: string): Promise<{ kind: "ok"; messages: MessageView[]; nextBefore: string | null } | TeamsFailure> {
  try {
    const page = await listMessages(p.laneId as LaneId, p.connectionId, p.userId, chatId, { before });
    const key = encodeChatKey(chatId);
    return { kind: "ok", messages: [...page.messages].filter((m) => !m.system).reverse().map((m) => messageView(m, chatImagesBase(p.laneId, key, m.id, p.connectionId))), nextBefore: page.nextBefore };
  } catch (e) {
    return teamsFailure(e);
  }
}


/**
 * What changed in an OPEN chat since a time (T-290): a notice arrived, or the person pressed Refresh. Microsoft is asked with a DATE RANGE (`lastModifiedDateTime gt <since>`, the terms ask for
 * it when reading new messages), one page. Oldest first. `since` is the newest message the person is shown (Microsoft's clock), so no clock of ours or the browser's is involved.
 */
export async function loadNewer(p: Omit<TeamsPerson, "client">, chatId: string, since: string): Promise<{ kind: "ok"; messages: MessageView[]; truncated: boolean } | TeamsFailure> {
  try {
    const page = await listMessages(p.laneId as LaneId, p.connectionId, p.userId, chatId, { sinceModified: since });
    const key = encodeChatKey(chatId);
    return { kind: "ok", messages: [...page.messages].filter((m) => !m.system).reverse().map((m) => messageView(m, chatImagesBase(p.laneId, key, m.id, p.connectionId))), truncated: page.truncated === true };
  } catch (e) {
    return teamsFailure(e);
  }
}
