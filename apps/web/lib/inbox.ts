// Functional Inbox (T-202). The list is metadata from comms.message_index through core.inbox_messages (SECURITY
// INVOKER: RLS applies, so only mail of lanes the user may read in the comms view). Opening a message first proves,
// with the user's own lane client, that the message is visible (core.inbox_message_ref), then reads the text live from
// Gmail: never stored (rule 6), shown as plain untrusted text (rule 9), nothing written anywhere (rule 5).
import type { Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import { gmailThreadUrl } from "@nichols/connectors/comms";
import { parseCoverageRows } from "@nichols/briefing/domain";
import { briefingFor } from "./briefing";

export const INBOX_FILTERS = ["all", "unread", "important"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];
export const PAGE_SIZE = 50;

export type InboxRow = {
  messageId: string;
  fromName: string | null;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: string;
  isRead: boolean;
  isImportant: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
};

export type InboxCursor = { before: string; id: string };

export type InboxView = { filter: InboxFilter; rows: InboxRow[]; next: InboxCursor | null; unavailable?: true };

const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export const isMessageId = (v: unknown): v is string => typeof v === "string" && MESSAGE_ID.test(v);

/** `?filter=unread&before=<iso>&bid=<id>`; anything malformed falls back to the first page of "all". */
export function parseInboxQuery(params: SearchParams): { filter: InboxFilter; cursor: InboxCursor | null } {
  const f = one(params.filter);
  const filter: InboxFilter = (INBOX_FILTERS as readonly string[]).includes(f ?? "") ? (f as InboxFilter) : "all";
  const before = one(params.before);
  const id = one(params.bid);
  const t = before !== undefined ? Date.parse(before) : Number.NaN;
  const cursor = !Number.isNaN(t) && isMessageId(id) ? { before: new Date(t).toISOString(), id } : null;
  return { filter, cursor };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export function toRows(data: unknown): InboxRow[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((r: Record<string, unknown>) => {
    const t = typeof r.received_at === "string" ? Date.parse(r.received_at) : Number.NaN;
    if (!isMessageId(r.message_id) || Number.isNaN(t)) return [];
    return [
      {
        messageId: r.message_id,
        fromName: str(r.from_name),
        fromAddress: str(r.from_address),
        subject: str(r.subject),
        receivedAt: new Date(t).toISOString(),
        isRead: r.is_read === true,
        isImportant: r.is_important === true,
        isStarred: r.is_starred === true,
        hasAttachments: r.has_attachments === true,
      },
    ];
  });
}

type Db = Pick<LaneClient, "schema">;

export async function loadInbox(client: Db, laneId: string, filter: InboxFilter, cursor: InboxCursor | null): Promise<InboxView> {
  const { data, error } = await client.schema("core").rpc("inbox_messages", {
    p_lane: laneId,
    p_filter: filter,
    p_limit: PAGE_SIZE,
    ...(cursor ? { p_before: cursor.before, p_before_id: cursor.id } : {}),
  });
  if (error) throw new Error("inbox unavailable");
  const rows = toRows(data);
  const last = rows[rows.length - 1];
  return { filter, rows, next: rows.length === PAGE_SIZE && last ? { before: last.receivedAt, id: last.messageId } : null };
}

export async function inboxFor(g: Pick<Guards, "requireLane">, laneId: string, params: SearchParams, load = loadInbox): Promise<InboxView> {
  const { client } = await g.requireLane(laneId as Parameters<Guards["requireLane"]>[0]);
  const { filter, cursor } = parseInboxQuery(params);
  try {
    return await load(client, laneId, filter, cursor);
  } catch {
    console.error("[inbox] list unavailable", { laneId });
    return { filter, rows: [], next: null, unavailable: true };
  }
}

// ---------------------------------------------------------------------------------------------------------- Still waiting (T-240)

/** `?view=waiting` shows the threads Home counts as "Still waiting": qualifying mail older than the fresh window. Anything else is the normal list. */
export const isWaitingView = (params: SearchParams): boolean => one(params.view) === "waiting";

export type WaitingView = { rows: InboxRow[]; /** The fresh window in hours (lane_config), for the page text. */ freshHours: number; unavailable?: true };

/**
 * The rows behind Home's "Still waiting" line, from the same ranking (rankAttention), newest first, with the caller's own lane client
 * (RLS and the comms view apply: a role without mail sees nothing). Metadata only. `load` is injected for tests.
 */
export async function waitingFor(g: Pick<Guards, "requireLane">, laneId: string, now: Date, load: typeof briefingFor = briefingFor): Promise<WaitingView> {
  const { client } = await g.requireLane(laneId as Parameters<Guards["requireLane"]>[0]);
  const view = await load(client, laneId, now, "America/New_York");
  const freshHours = view.config.attention.fresh_hours;
  if (!view.mail.access) return { rows: [], freshHours, ...(view.mail.unavailable ? { unavailable: true as const } : {}) };
  const rows = view.mail.stillWaiting.flatMap((a) =>
    isMessageId(a.thread.messageId)
      ? [{ messageId: a.thread.messageId, fromName: a.thread.fromName, fromAddress: a.thread.fromAddress, subject: a.thread.subject, receivedAt: a.thread.receivedAt, isRead: a.thread.unreadCount === 0, isImportant: a.thread.isImportant, isStarred: false, hasAttachments: false }]
      : [],
  );
  return { rows, freshHours };
}

// ---------------------------------------------------------------------------------------------------------- one message

export type MessageMeta = {
  messageId: string;
  fromName: string | null;
  fromAddress: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  receivedAt: string;
  /** The connected mailbox this message sits in (from Coverage), or null when it could not be told. */
  mailbox: string | null;
  /** "Open in Gmail": https://mail.google.com/mail/?authuser=<mailbox>#all/<thread id>; null unless both are usable. */
  gmailUrl: string | null;
};

export type MessageView =
  | { state: "not_found" }
  | { state: "ok"; meta: MessageMeta; text: string; truncated: boolean }
  | { state: "body_unavailable"; meta: MessageMeta; reason: "reconnect" | "gone" | "error" };

/** The live body read: injected so tests never call Google. Returns the revealed text (the caller never stores it). */
export type ReadBody = (laneId: string, connectionId: string, messageId: string) => Promise<{ text: string; truncated: boolean }>;

// Bidi overrides/isolates and control characters (except tab and newline) can make text read differently on screen.
const SPOOF = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
/** Display-safe text: React escapes HTML; this removes characters that could disguise what the text says. */
export const displayText = (v: string): string => v.replace(SPOOF, "");

function addresses(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a: unknown) => {
    if (typeof a !== "object" || a === null) return [];
    const { name, address } = a as { name?: unknown; address?: unknown };
    const addr = typeof address === "string" ? address : null;
    const nm = typeof name === "string" && name.trim() !== "" ? name : null;
    return addr ? [nm ? `${nm} <${addr}>` : addr] : [];
  });
}

/** The mailbox address of a connection, from Coverage (core.briefing_coverage answers only for the caller's own comms view). Null on any failure: the link is then left out, the message still opens. */
async function mailboxOf(client: Db, laneId: string, connectionId: string): Promise<string | null> {
  try {
    const { data, error } = await client.schema("core").rpc("briefing_coverage", { p_lane: laneId });
    if (error) return null;
    return parseCoverageRows(data).find((c) => c.stream === "mail" && c.connectionId === connectionId)?.account || null;
  } catch {
    return null;
  }
}

/**
 * Proves visibility under RLS with the user's client, then reads the body live. A message the user may not see (other
 * lane, no comms view, AAL1, unknown or malformed id) is `not_found`, and Google is never called for it.
 */
export async function openMessage(client: Db, laneId: string, messageId: string, readBody: ReadBody): Promise<MessageView> {
  if (!isMessageId(messageId)) return { state: "not_found" };
  const { data, error } = await client.schema("core").rpc("inbox_message_ref", { p_lane: laneId, p_message_id: messageId });
  if (error) throw new Error("message unavailable");
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row || typeof row.connection_id !== "string" || row.provider !== "google" || typeof row.received_at !== "string") return { state: "not_found" };
  const mailbox = await mailboxOf(client, laneId, row.connection_id);
  const meta: MessageMeta = {
    messageId,
    fromName: str(row.from_name),
    fromAddress: str(row.from_address),
    to: addresses(row.to_recipients),
    cc: addresses(row.cc_recipients),
    subject: (v => v && displayText(v))(str(row.subject)),
    receivedAt: new Date(Date.parse(row.received_at)).toISOString(),
    mailbox,
    gmailUrl: gmailThreadUrl(mailbox, str(row.thread_id)),
  };
  try {
    const body = await readBody(laneId, row.connection_id, messageId);
    return { state: "ok", meta, text: displayText(body.text), truncated: body.truncated };
  } catch (e) {
    const kind = typeof e === "object" && e !== null && "info" in e ? (e as { info?: { kind?: unknown } }).info?.kind : undefined;
    // Kind only: never the message, never the body.
    console.error("[inbox] body unavailable", { laneId, kind: typeof kind === "string" ? kind : "unknown" });
    return { state: "body_unavailable", meta, reason: kind === "reconnect_required" || kind === "forbidden" ? "reconnect" : kind === "not_found" ? "gone" : "error" };
  }
}

export async function messageFor(g: Pick<Guards, "requireLane">, laneId: string, messageId: string, readBody: ReadBody): Promise<MessageView> {
  const { client } = await g.requireLane(laneId as Parameters<Guards["requireLane"]>[0]);
  return openMessage(client, laneId, messageId, readBody);
}
