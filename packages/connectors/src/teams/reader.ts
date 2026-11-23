// The Teams chat reader (T-281, T-284; spec 8, 8.1, 8.3, 13): every call is a GET through the guarded, read-only Teams client (`./api.ts`: fixed templates, validated ids, the actor is the signed-in
// owner, the guard runs first) and every answer is a strict projection. What is not projected is dropped in memory.
//
// Rule 6: chat topics, member names, previews, message text and attachment names are fetched live and returned to the caller of ONE request. This module never stores, caches, logs, audits or puts
// them in an event or an error: its errors are fixed texts, and the only log line (`teams.chats.expand_fallback`) names no content. There is no module state.
// Rule 9: a message body goes through ./message-html.ts and leaves as typed nodes (no raw HTML); a link or an attachment link is https only; mentions are text; a picture is a placeholder.
// Microsoft's terms (vendor facts A1, A2, A3): no polling (a call is made when a person opens the page, refreshes or opens a chat), `$top` at most 50, `$orderby` only on the documented property,
// a date range with the orderby it needs, paging by an explicit action, and no retry at all (a 429 reaches the page as `rate_limited` with its Retry-After).
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError, isConnectorError } from "../contract/errors";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { TeamsApi, TeamsSelf } from "./api";
import { TEAMS_PARAM_FORMATS } from "./constants";
import { bodyToNodes, cleanText, cutUnits, nodesToPlainText, safeHttpsUrl, type MessageNode } from "./message-html";

// ---- limits (vendor facts A1: `$top` at most 50; at most 25 members come back with `$expand=members`)
export const CHATS_PAGE = 50;
export const MESSAGES_PAGE = 30;
export const NEW_SINCE_PAGE = 50;
export const PREVIEW_CHARS = 160;
export const MEMBER_EXPAND_LIMIT = 25;
/** Our own cap on a call link (spec 13): the maximum number of users in a deep link is not confirmed. */
export const CALL_MAX_OTHERS = 10;
/** With the fallback (no combined expand) members are read for at most this many chats, in parallel (spec 8 notes). */
export const FALLBACK_MEMBER_READS = 20;
const NAME_CHARS = 120;
/** A name that is empty after cleaning (hangul fillers, braille blank, ...) is drawn as this, never as nothing (SL6). */
export const NO_NAME = "(no name)";
const TOPIC_CHARS = 200;
const ATTACHMENTS_MAX = 20;
const TEAMS_WEB_HOST = "teams.microsoft.com";
/** A page read gives up after this long (the shared client's default is 30 s): a slow Graph answer is "could not load", not a long skeleton. */
export const PAGE_TIMEOUT_MS = 12_000;

// ---- the projections
export type TeamsMember = { userId: string | null; displayName: string; tenantId: string | null; /** Outside the person's tenant, or a guest (`roles` has `guest`): labelled, no Call buttons. */ external: boolean; self: boolean };
export type ChatPreview = { createdAt: string; senderId: string | null; senderName: string | null; mine: boolean; text: string; deleted: boolean; system: boolean };
export type TeamsChat = {
  chatId: string;
  chatType: "oneOnOne" | "group" | "meeting" | "other";
  topic: string | null;
  /** `https://teams.microsoft.com/...` only (anything else is dropped), for Open in Teams. */
  webUrl: string | null;
  members: TeamsMember[];
  /** Graph returns at most 25 members with the chat list: more may exist ("and others"). */
  membersCapped: boolean;
  preview: ChatPreview | null;
  /** `viewpoint.lastMessageReadDateTime` (Teams' own read state), when present. */
  lastReadAt: string | null;
  hidden: boolean;
};
export type ChatList = { chats: TeamsChat[]; nextCursor: string | null; self: TeamsSelf };

export type AttachmentStub = {
  kind: "file" | "reply" | "card" | "other";
  name: string;
  /** https on a Microsoft file host only (`MICROSOFT_FILE_HOSTS`), opens in the person's own session; null otherwise. Never fetched by the portal. */
  href: string | null;
  /** The link's host, drawn beside it (SM1). */
  host: string | null;
};
export type ChatMessage = {
  id: string;
  createdAt: string;
  modifiedAt: string | null;
  edited: boolean;
  deleted: boolean;
  /** A message type other than a person's message (a system event): drawn as "Teams event", never its text. */
  system: boolean;
  sender: { id: string | null; name: string | null; kind: "user" | "app" | "unknown" };
  mine: boolean;
  nodes: MessageNode[];
  truncated: boolean;
  attachments: AttachmentStub[];
};
export type MessagePage = { messages: ChatMessage[]; /** The `createdAt` to ask "older than" next; null when this was the last page. */ nextBefore: string | null; self: TeamsSelf };

export type CallTargets = { ok: true; upns: string[] } | { ok: false; reason: "no_one" | "external" | "too_many" | "unresolved" };

// ---- helpers
const fixed = (kind: "invalid_input" | "provider_error", message: string) => new ConnectorError({ kind, message });
const UUID = TEAMS_PARAM_FORMATS.userId as RegExp;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$/;

/** A Graph timestamp as a millisecond-precision ISO string (`...Z`), or null. Microsoft's clock, never ours. */
export function normalizeTime(v: unknown): string | null {
  if (typeof v !== "string" || !ISO.test(v)) return null;
  const ms = Date.parse(v.replace(/(\.\d{3})\d+Z$/, "$1Z"));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const lowerUuid = (v: unknown): string | null => (typeof v === "string" && UUID.test(v.toLowerCase()) ? v.toLowerCase() : null);
const text = (v: unknown, max: number): string => (typeof v === "string" ? cutUnits(cleanText(v).trim(), max) : "");

const Opt = <T extends z.ZodType>(t: T) => t.nullish();
const BodySchema = z.looseObject({ contentType: Opt(z.string().max(32)), content: Opt(z.string()) });
const FromSchema = z.looseObject({
  user: Opt(z.looseObject({ id: Opt(z.string().max(64)), displayName: Opt(z.string().max(512)) })),
  application: Opt(z.looseObject({ id: Opt(z.string().max(64)), displayName: Opt(z.string().max(512)) })),
});
const MemberSchema = z.looseObject({ userId: Opt(z.string().max(64)), displayName: Opt(z.string().max(512)), tenantId: Opt(z.string().max(64)), roles: Opt(z.array(z.string().max(64)).max(20)) });
const ChatSchema = z.looseObject({
  id: z.string().max(256),
  chatType: Opt(z.string().max(32)),
  topic: Opt(z.string().max(2048)),
  webUrl: Opt(z.string().max(4096)),
  viewpoint: Opt(z.looseObject({ isHidden: Opt(z.boolean()), lastMessageReadDateTime: Opt(z.string().max(64)) })),
  members: Opt(z.array(z.unknown()).max(500)),
  lastMessagePreview: Opt(
    z.looseObject({ createdDateTime: Opt(z.string().max(64)), isDeleted: Opt(z.boolean()), messageType: Opt(z.string().max(64)), from: Opt(FromSchema), body: Opt(BodySchema) }),
  ),
});
const AttachmentSchema = z.looseObject({ contentType: Opt(z.string().max(256)), contentUrl: Opt(z.string().max(4096)), name: Opt(z.string().max(1024)) });
const MessageSchema = z.looseObject({
  id: z.string().max(512),
  messageType: Opt(z.string().max(64)),
  createdDateTime: Opt(z.string().max(64)),
  lastModifiedDateTime: Opt(z.string().max(64)),
  lastEditedDateTime: Opt(z.string().max(64)),
  deletedDateTime: Opt(z.string().max(64)),
  from: Opt(FromSchema),
  body: Opt(BodySchema),
  attachments: Opt(z.array(z.unknown()).max(200)),
});
const PageSchema = z.looseObject({ value: z.array(z.unknown()).max(500), "@odata.nextLink": Opt(z.string().max(8192)) });

const sameTenant = (a: string | null | undefined, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

function memberOf(raw: unknown, self: TeamsSelf): TeamsMember | null {
  const r = MemberSchema.safeParse(raw);
  if (!r.success) return null;
  const userId = lowerUuid(r.data.userId);
  const tenant = typeof r.data.tenantId === "string" && r.data.tenantId !== "" ? r.data.tenantId.toLowerCase() : null;
  return {
    userId,
    displayName: text(r.data.displayName, NAME_CHARS) || NO_NAME,
    tenantId: tenant,
    // another tenant, no tenant given at all (cannot be shown to be ours), or the `guest` role: external (no call button; labelled)
    external: !sameTenant(tenant, self.tenantId) || (r.data.roles ?? []).some((x) => x.toLowerCase() === "guest"),
    self: userId !== null && userId === self.entraObjectId.toLowerCase(),
  };
}

function chatOf(raw: unknown, self: TeamsSelf): TeamsChat | null {
  const r = ChatSchema.safeParse(raw);
  if (!r.success || !TEAMS_PARAM_FORMATS.chatId?.test(r.data.id)) return null;
  const c = r.data;
  const members = (c.members ?? []).flatMap((m) => memberOf(m, self) ?? []);
  const p = c.lastMessagePreview;
  let preview: ChatPreview | null = null;
  const createdAt = normalizeTime(p?.createdDateTime);
  if (p && createdAt) {
    const senderId = lowerUuid(p.from?.user?.id);
    const type = p.messageType ?? "message";
    const system = type !== "message";
    const converted = system || p.isDeleted === true ? null : bodyToNodes(p.body?.contentType, p.body?.content);
    preview = {
      createdAt,
      senderId,
      senderName: p.from?.user ? text(p.from.user.displayName, NAME_CHARS) || NO_NAME : p.from?.application ? text(p.from.application.displayName, NAME_CHARS) || NO_NAME : null,
      mine: senderId !== null && senderId === self.entraObjectId.toLowerCase(),
      text: converted ? nodesToPlainText(converted.nodes, PREVIEW_CHARS) : "",
      deleted: p.isDeleted === true,
      system,
    };
  }
  const webUrl = typeof c.webUrl === "string" ? safeHttpsUrl(c.webUrl) : null;
  const type = c.chatType === "oneOnOne" || c.chatType === "group" || c.chatType === "meeting" ? c.chatType : "other";
  return {
    chatId: c.id,
    chatType: type,
    topic: text(c.topic, TOPIC_CHARS) || null,
    webUrl: webUrl && webUrl.host === TEAMS_WEB_HOST ? webUrl.href : null,
    members,
    membersCapped: (c.members?.length ?? 0) >= MEMBER_EXPAND_LIMIT,
    preview,
    lastReadAt: normalizeTime(c.viewpoint?.lastMessageReadDateTime),
    hidden: c.viewpoint?.isHidden === true,
  };
}

/**
 * Unread (spec 8.1): the newest message is not the person's own, and it is newer than the later of Teams' own read time and the portal's marker. Both sides compare at millisecond precision
 * (the portal's marker is stored at that precision). A hidden chat is never listed, so it is never unread here.
 */
export function chatIsUnread(chat: Pick<TeamsChat, "preview" | "lastReadAt" | "hidden">, portalReadThrough: string | null): boolean {
  // a system event as the newest item cannot be shown or marked read in the conversation (events are not requested), so it must not leave a dot behind
  if (chat.hidden || !chat.preview || chat.preview.mine || chat.preview.system) return false;
  const newest = Date.parse(chat.preview.createdAt);
  const readTeams = chat.lastReadAt ? Date.parse(chat.lastReadAt) : -Infinity;
  const readHere = portalReadThrough ? Date.parse(portalReadThrough) : -Infinity;
  return newest > Math.max(readTeams, Number.isNaN(readHere) ? -Infinity : readHere);
}

// ---- the opaque cursor: only a `$skiptoken` leaves Graph's nextLink; the link itself never reaches the browser
const TOKEN = /^[\x21-\x7e]{1,2048}$/; // printable ASCII without space; bound
const CURSOR = /^[A-Za-z0-9_-]{1,3200}$/;
function cursorFromNextLink(link: unknown, path: string): string | null {
  if (typeof link !== "string" || !URL.canParse(link)) return null;
  const u = new URL(link);
  if (u.protocol !== "https:" || u.hostname !== "graph.microsoft.com" || u.port !== "" || u.username !== "" || u.pathname !== `/v1.0${path}`) return null;
  const token = u.searchParams.get("$skiptoken");
  if (token === null || !TOKEN.test(token) || /[&#%\\]/.test(token)) return null;
  return Buffer.from(JSON.stringify({ v: 1, p: path, s: token }), "utf8").toString("base64url");
}
function skipTokenFrom(cursor: string, path: string): string {
  const bad = () => fixed("invalid_input", "The page cursor is not valid");
  if (!CURSOR.test(cursor)) throw bad();
  let o: unknown;
  try {
    o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  const r = z.object({ v: z.literal(1), p: z.literal(path), s: z.string() }).safeParse(o);
  if (!r.success || !TOKEN.test(r.data.s) || /[&#%\\]/.test(r.data.s)) throw bad();
  return r.data.s;
}

/**
 * The hosts a file attachment's link may point to (SM1): SharePoint and OneDrive. A suffix match on a dot boundary: `x.sharepoint.com` yes, `sharepoint.com.evil.example`, `evilsharepoint.com`, a trailing-dot
 * host and a punycode look-alike no. (The fact sheet says only "SharePoint/OneDrive links"; the host names are the public ones, checked live in H-081.) Any other host: no link, "open it in Teams".
 */
export const MICROSOFT_FILE_HOSTS: readonly string[] = ["sharepoint.com", "onedrive.live.com", "1drv.ms"];
export const isMicrosoftFileHost = (host: string): boolean => MICROSOFT_FILE_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));

function attachmentOf(raw: unknown): AttachmentStub | null {
  const r = AttachmentSchema.safeParse(raw);
  if (!r.success) return null;
  const type = (r.data.contentType ?? "").toLowerCase();
  const link = typeof r.data.contentUrl === "string" ? safeHttpsUrl(r.data.contentUrl) : null;
  let kind: AttachmentStub["kind"];
  // The labels are a heuristic on the content type's wording (vendor facts A1 name `contentType`, `contentUrl`, `name`; the type strings are checked live, H-081); the safe default is "other".
  if (type === "messagereference") kind = "reply";
  else if (type.includes("card")) kind = "card";
  else if (type === "reference" || link) kind = "file";
  else kind = "other";
  const name = text(r.data.name, 200);
  const ok = kind === "file" && link !== null && isMicrosoftFileHost(link.host);
  return { kind, name, href: ok && link ? link.href : null, host: ok && link ? link.host : null };
}

function messageOf(raw: unknown, self: TeamsSelf): ChatMessage | null {
  const r = MessageSchema.safeParse(raw);
  if (!r.success || !TEAMS_PARAM_FORMATS.messageId?.test(r.data.id)) return null;
  const m = r.data;
  const createdAt = normalizeTime(m.createdDateTime);
  if (!createdAt) return null;
  const deleted = typeof m.deletedDateTime === "string" && m.deletedDateTime !== "";
  const system = (m.messageType ?? "message") !== "message";
  const userId = lowerUuid(m.from?.user?.id);
  const sender: ChatMessage["sender"] = m.from?.user
    ? { id: userId, name: text(m.from.user.displayName, NAME_CHARS) || NO_NAME, kind: "user" }
    : m.from?.application
      ? { id: null, name: text(m.from.application.displayName, NAME_CHARS) || NO_NAME, kind: "app" }
      : { id: null, name: null, kind: "unknown" };
  // A deleted message and a system event show no body: the text is not even converted.
  const body = deleted || system ? { nodes: [] as MessageNode[], truncated: false } : bodyToNodes(m.body?.contentType, m.body?.content);
  return {
    id: m.id,
    createdAt,
    modifiedAt: normalizeTime(m.lastModifiedDateTime),
    edited: !deleted && !system && normalizeTime(m.lastEditedDateTime) !== null,
    deleted,
    system,
    sender,
    mine: userId !== null && userId === self.entraObjectId.toLowerCase(),
    nodes: body.nodes,
    truncated: body.truncated,
    attachments: deleted || system ? [] : (m.attachments ?? []).slice(0, ATTACHMENTS_MAX).flatMap((a) => attachmentOf(a) ?? []),
  };
}

// ---- the reader
export type TeamsReaderDeps = { api: TeamsApi; logger?: ConnectorLogger };
type Conn = unknown;

export function createTeamsReader(deps: TeamsReaderDeps) {
  const log = deps.logger ?? connectorLog;
  const get = <T>(laneId: LaneId, conn: Conn, userId: string, req: { path: string; params?: Record<string, string>; query?: Record<string, string | number> }) =>
    deps.api.get<T>(laneId, conn, { ...req, actor: { kind: "user", userId }, retry: false, timeoutMs: PAGE_TIMEOUT_MS });
  const pageOf = (data: unknown) => {
    const p = PageSchema.safeParse(data);
    if (!p.success) throw fixed("provider_error", "Teams returned an answer the portal does not understand");
    return p.data;
  };

  async function listMembers(laneId: LaneId, conn: Conn, userId: string, chatId: string): Promise<{ members: TeamsMember[]; more: boolean; self: TeamsSelf }> {
    const res = await get<unknown>(laneId, conn, userId, { path: "/chats/{chatId}/members", params: { chatId } });
    const page = pageOf(res.data);
    return { members: page.value.flatMap((m) => memberOf(m, res.self) ?? []), more: typeof page["@odata.nextLink"] === "string", self: res.self };
  }

  return {
    /**
     * One page of the person's chats, newest message first, hidden chats left out. `cursor` (from the previous page, by an explicit "More chats") continues it. When Graph refuses the combined
     * `$expand=members,lastMessagePreview` (H-081 checks it), the previews are asked for alone and members are read for the first chats in parallel; a log line says so (no content).
     */
    async listChats(laneId: LaneId, conn: Conn, userId: string, opts: { cursor?: string } = {}): Promise<ChatList> {
      const skip = opts.cursor !== undefined ? skipTokenFrom(opts.cursor, "/me/chats") : undefined;
      const base = { $orderby: "lastMessagePreview/createdDateTime desc", $top: CHATS_PAGE, ...(skip !== undefined ? { $skiptoken: skip } : {}) };
      let combined = true;
      let res;
      try {
        res = await get<unknown>(laneId, conn, userId, { path: "/me/chats", query: { $expand: "members,lastMessagePreview", ...base } });
      } catch (e) {
        if (!(isConnectorError(e) && e.info.kind === "invalid_input" && e.info.http_status === 400)) throw e;
        combined = false;
        log.warn("teams.chats.expand_fallback", { laneId });
        res = await get<unknown>(laneId, conn, userId, { path: "/me/chats", query: { $expand: "lastMessagePreview", ...base } });
      }
      const page = pageOf(res.data);
      let chats = page.value.flatMap((c) => chatOf(c, res.self) ?? []);
      if (!combined) {
        const first = chats.slice(0, FALLBACK_MEMBER_READS);
        const got = await Promise.allSettled(first.map((c) => listMembers(laneId, conn, userId, c.chatId)));
        chats = chats.map((c) => {
          const k = first.indexOf(c);
          const r = k >= 0 ? got[k] : undefined;
          return r?.status === "fulfilled" ? { ...c, members: r.value.members, membersCapped: r.value.more } : c;
        });
      }
      const nextCursor = cursorFromNextLink(page["@odata.nextLink"], "/me/chats");
      // a next link we cannot turn into a cursor (no `$skiptoken`, another host or path): "More chats" is not offered; a content-free line says so for the live check
      if (nextCursor === null && typeof page["@odata.nextLink"] === "string") log.warn("teams.chats.no_cursor", { laneId });
      return { chats: chats.filter((c) => !c.hidden), nextCursor, self: res.self };
    },

    /** All members of one chat (the first page Graph returns; `more` is true when there are more than that). */
    listMembers,

    /** One chat's own fields (topic, type, link): no members and no preview (read them with `listMembers`). `null` when the answer is not a chat. */
    async getChat(laneId: LaneId, conn: Conn, userId: string, chatId: string): Promise<{ chat: TeamsChat | null; self: TeamsSelf }> {
      const res = await get<unknown>(laneId, conn, userId, { path: "/chats/{chatId}", params: { chatId } });
      return { chat: chatOf(res.data, res.self), self: res.self };
    },

    /**
     * One page of a chat's messages, newest first. `before` (a `createdAt` from the previous page, by an explicit "Load older messages") pages back with `createdDateTime lt`; `sinceModified`
     * asks for what changed after a time (`lastModifiedDateTime gt`, a date range as the terms ask, ordered on the same property). The two are exclusive. Both timestamps are validated and
     * rebuilt by `toISOString`, never pasted.
     */
    async listMessages(laneId: LaneId, conn: Conn, userId: string, chatId: string, opts: { before?: string; sinceModified?: string } = {}): Promise<MessagePage> {
      if (opts.before !== undefined && opts.sinceModified !== undefined) throw fixed("invalid_input", "Ask for older messages or for changes, not both");
      const before = opts.before !== undefined ? normalizeTime(opts.before) : undefined;
      const since = opts.sinceModified !== undefined ? normalizeTime(opts.sinceModified) : undefined;
      if (before === null || since === null) throw fixed("invalid_input", "The time is not valid");
      const top = since !== undefined ? NEW_SINCE_PAGE : MESSAGES_PAGE;
      const query =
        since !== undefined
          ? { $top: top, $orderby: "lastModifiedDateTime desc", $filter: `lastModifiedDateTime gt ${since}` }
          : { $top: top, $orderby: "createdDateTime desc", ...(before !== undefined ? { $filter: `createdDateTime lt ${before}` } : {}) };
      const res = await get<unknown>(laneId, conn, userId, { path: "/chats/{chatId}/messages", params: { chatId }, query });
      const page = pageOf(res.data);
      const messages = page.value.flatMap((m) => messageOf(m, res.self) ?? []);
      const oldest = messages.reduce<string | null>((acc, m) => (acc === null || m.createdAt < acc ? m.createdAt : acc), null);
      return { messages, nextBefore: since === undefined && (page.value.length >= top || typeof page["@odata.nextLink"] === "string") && oldest !== null ? oldest : null, self: res.self };
    },

    /**
     * Who a call would ring (spec 13): the chat's other members, resolved to sign-in names (`User.ReadBasic.All`), in memory only. Refused when no one else is in the chat, when anyone is
     * outside the person's tenant or a guest, when more than CALL_MAX_OTHERS others are in it, or when a name cannot be resolved to a plain address (no comma, `&`, `#` or `=`, which would
     * change the link).
     */
    async resolveCallTargets(laneId: LaneId, conn: Conn, userId: string, chatId: string): Promise<CallTargets> {
      const { members, more } = await listMembers(laneId, conn, userId, chatId);
      const blocked = callBlockReason(members, more);
      if (blocked) return { ok: false, reason: blocked };
      const others = members.filter((m) => !m.self);
      const ids = others.map((m) => m.userId);
      if (ids.some((i) => i === null) || new Set(ids).size !== ids.length) return { ok: false, reason: "unresolved" };
      const upns = await Promise.all(
        (ids as string[]).map(async (id) => {
          try {
            const r = await get<unknown>(laneId, conn, userId, { path: "/users/{userId}", params: { userId: id }, query: { $select: "userPrincipalName" } });
            const p = z.looseObject({ userPrincipalName: z.string().max(320) }).safeParse(r.data);
            return p.success ? upnOf(p.data.userPrincipalName) : null;
          } catch (e) {
            if (isConnectorError(e) && e.info.kind === "not_found") return null; // a member without an account any more: no call link ("unresolved")
            throw e;
          }
        }),
      );
      if (upns.some((u) => u === null)) return { ok: false, reason: "unresolved" };
      return { ok: true, upns: upns as string[] };
    },
  };
}

/** Why a chat gets no Call buttons (spec 13): nobody else in it, anyone outside the person's tenant, or more people than a link carries. `null`: calls are allowed (names still have to resolve). */
export function callBlockReason(members: readonly TeamsMember[], more: boolean): "no_one" | "external" | "too_many" | null {
  const others = members.filter((m) => !m.self);
  if (others.length === 0) return "no_one";
  if (others.some((m) => m.external)) return "external";
  if (more || others.length > CALL_MAX_OTHERS) return "too_many";
  return null;
}

/** A sign-in name safe to put in a deep link: one plain address, no guest marker, none of the characters that separate or change a link's parts. Lower-cased. */
export function upnOf(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!/^[a-z0-9._'+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) || s.length > 254) return null;
  if (s.includes("#ext#")) return null;
  return s;
}

export type TeamsReader = ReturnType<typeof createTeamsReader>;
