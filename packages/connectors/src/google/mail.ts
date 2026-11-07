// Gmail MailProvider (T-063): metadata sync, live body, live search, polling watch and prepareWrite. Read-only against
// Gmail by construction (the API client has GET only). Implements the T-062 interface and passes its contract suite.
//
// Sync (metadata only, rule 6): `messages.list` + `messages.get?format=metadata` with a fixed set of headers for the
// first load; `users.history.list` from a historyId afterwards. Never `format=full` or `raw` here, and the snippet Gmail
// adds to metadata responses is dropped at parse time and never kept. The cursor is one composite string bound to the
// connection (`g1.<connection id>.<state>`):
//   h:<historyId>                      caught up; next sync reads history from here
//   i:<historyId>:<pageToken>          mid-run page of history.list
//   f:<historyId>:<afterEpoch>:<token> mid-run page of the first load (historyId taken BEFORE listing, so mail that
//                                      arrives while listing is caught by the first incremental sync)
// A cursor of another connection, a malformed one or one Gmail no longer has (history 404) is `fullResyncRequired`.
//
// Mapping (T-062 doc): folder = "INBOX" when the INBOX label is set, else null; labels = Gmail label ids; is_important =
// IMPORTANT; is_read = no UNREAD; is_starred = STARRED; has_attachments = Content-Type multipart/mixed (a header
// heuristic: metadata responses carry no parts); source_updated_at = internalDate (Gmail has no modified time, and the
// apply keeps a row when the incoming version is not older).
//
// Trash and spam: a message carrying TRASH or SPAM (seen on fetch after a label event) is reported as a removal, matching
// messages.list which leaves them out; removing the TRASH label brings it back as an upsert.
//
// readBody is a live `format=full` fetch, walked to text, wrapped in UntrustedBody; nothing is stored or cached.
// Gmail push (users.watch + Pub/Sub) is T-065: until then `watch` answers polling mode and creates no resources.
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { UntrustedBody } from "../comms/ephemeral";
import type { MailCapabilities, MailProvider } from "../comms/provider";
import {
  CommsCursorSchema,
  CommsSyncOptionsSchema,
  EMAIL_PAYLOAD_SCHEMA_VERSION,
  MailSyncResultSchema,
  MailWriteIntentSchema,
  MessageMetaSchema,
  ProviderIdParamSchema,
  ReadBodyOptionsSchema,
  SearchQuerySchema,
  type CommsCursor,
  type MailSyncResult,
  type MessageMeta,
  type WatchInfo,
} from "../comms/schemas";
import { ConnectorError, isConnectorError } from "../contract/errors";
import type { LaneBoundConnection } from "../contract/lane-bound";
import { ProposedPayloadSchema, type ProposedPayload, type SourceResult } from "../contract/schemas";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { LaneConfigReader } from "../vault/lane-config";
import type { GoogleApi } from "./api";
import { DEFAULT_FULL_SYNC_DAYS, DEFAULT_MAX_BODY_CHARS, HISTORY_TYPES, METADATA_HEADERS } from "./constants";
import { createProviderGuard } from "./guard";
import { cleanText, MAX_SINGLE_HEADER, parseAddressList, parseSubject } from "./headers";
import { extractText, type GmailPart } from "./mime";

export type GmailProviderDeps = {
  api: GoogleApi;
  /** The authoritative connection row (status, lane, provider), read on every call. */
  connections: { load(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<string>> };
  /**
   * `mailboxes` is re-read on every sync, read and search (a mailbox removed from the lane stops working at once);
   * `retentionDays` bounds the first load to the lane policy and fails closed when unreadable.
   */
  laneConfig: Pick<LaneConfigReader, "mailboxes" | "retentionDays">;
  now?: () => number;
  logger?: ConnectorLogger;
  /** Upper bound on days of mail the first load covers: min(this, the lane policy's retention_days). Default 90. */
  fullSyncDays?: number;
  /** Parallel metadata fetches per page. Default 4 (8 tripped Gmail's per-user rate limit on a first load). */
  concurrency?: number;
};

const DAY_MS = 86_400_000;
const PATH_MESSAGES = "/gmail/v1/users/me/messages";
const PATH_MESSAGE = "/gmail/v1/users/me/messages/{id}";
const PATH_HISTORY = "/gmail/v1/users/me/history";
const PATH_PROFILE = "/gmail/v1/users/me/profile";

const PageToken = "[A-Za-z0-9_=+/.%-]{1,2048}";
const CURSOR_RE = new RegExp(`^g1\\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.(?:h:(\\d{1,20})|i:(\\d{1,20}):(${PageToken})|f:(\\d{1,20}):(\\d{1,12}):(${PageToken}|-))$`);

type CursorState =
  | { kind: "history"; historyId: string }
  | { kind: "history_page"; historyId: string; pageToken: string }
  | { kind: "list_page"; historyId: string; after: number; pageToken: string | null };

/** The cursor's state when it is well-formed AND belongs to this connection; null otherwise (-> fullResyncRequired). */
export function parseCursor(value: string, connectionId: string): CursorState | null {
  const m = CURSOR_RE.exec(value);
  if (!m || m[1] !== connectionId) return null;
  if (m[2] !== undefined) return { kind: "history", historyId: m[2] };
  if (m[3] !== undefined && m[4] !== undefined) return { kind: "history_page", historyId: m[3], pageToken: m[4] };
  if (m[5] !== undefined && m[6] !== undefined && m[7] !== undefined) return { kind: "list_page", historyId: m[5], after: Number(m[6]), pageToken: m[7] === "-" ? null : m[7] };
  return null;
}

const cursorOf = (connectionId: string, state: string): CommsCursor => ({ value: `g1.${connectionId}.${state}` });

const MessageRefsSchema = z.object({ messages: z.array(z.object({ id: z.string() })).optional(), nextPageToken: z.string().optional() });
const MetaResponseSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().regex(/^\d{1,16}$/).optional(),
  // `snippet` is deliberately not declared: zod drops it, so a preview can never reach a record.
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).optional() }).optional(),
});
type MetaResponse = z.infer<typeof MetaResponseSchema>;
const HistoryResponseSchema = z.object({
  history: z
    .array(
      z.object({
        messagesAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).optional(),
        messagesDeleted: z.array(z.object({ message: z.object({ id: z.string() }) })).optional(),
        labelsAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).optional(),
        labelsRemoved: z.array(z.object({ message: z.object({ id: z.string() }) })).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  historyId: z.string().regex(/^\d{1,20}$/).optional(),
});
const ProfileSchema = z.object({ historyId: z.string().regex(/^\d{1,20}$/) });
const FullMessageSchema = z.object({ payload: z.custom<GmailPart>((v) => typeof v === "object" && v !== null).optional() });

const invalid = (message: string) => new ConnectorError({ kind: "invalid_input", message });

/** Gmail `q` for a plain-text query: one quoted phrase, so operators (`from:`, `OR`, `-`, `{}`) inside it are literal. */
export function quoteGmailQuery(query: string): string {
  const phrase = cleanText(query.replace(/["\\]/g, " ")).slice(0, 500);
  return `"${phrase}"`;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  // Once one item fails the page fails: the other workers take no new items (reads already in flight finish). Without
  // this they kept reading, and retrying rate limits, for minutes after the run had failed (Nov 6, 2026 review M1).
  let failed = false;
  const worker = async () => {
    for (;;) {
      if (failed) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i] as T);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function createGmailProvider(deps: GmailProviderDeps): MailProvider<"google"> {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? connectorLog;
  const fullDays = deps.fullSyncDays ?? DEFAULT_FULL_SYNC_DAYS;
  const concurrency = deps.concurrency ?? 4;
  const capabilities: MailCapabilities = { watch: "polling", prepareWrite: true };

  const guard = createProviderGuard({ connections: deps.connections, laneConfig: deps.laneConfig });

  const envelope = <T>(laneId: LaneId, conn: LaneBoundConnection<"google">, op: string, data: T): SourceResult<T, "google"> => {
    const at = new Date(now()).toISOString();
    return { lane_id: laneId, provider: "google", connection_id: conn.id, op, data, as_of: at, fetched_at: at, freshness: "live", provider_tid: null, source_refs: [], notes: [] };
  };

  function toMeta(conn: LaneBoundConnection<"google">, m: MetaResponse): MessageMeta | null {
    const headers = new Map<string, string>();
    for (const h of m.payload?.headers ?? []) if (!headers.has(h.name.toLowerCase())) headers.set(h.name.toLowerCase(), h.value);
    const labelIds = m.labelIds ?? [];
    const has = (l: string) => labelIds.includes(l);
    const fromList = parseAddressList(headers.get("from"), 1, MAX_SINGLE_HEADER);
    const ms = m.internalDate !== undefined ? Number(m.internalDate) : Date.parse(headers.get("date") ?? "");
    // Never invent a time: a message with neither internalDate nor a parseable Date header is skipped (and logged).
    if (!Number.isFinite(ms)) return null;
    const received = new Date(ms).toISOString();
    const labels = labelIds.filter((l) => l.length >= 1 && l.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(l)).slice(0, 50);
    const base = {
      message_id: m.id,
      thread_id: m.threadId ?? null,
      source_url: `https://mail.google.com/mail/u/${encodeURIComponent(conn.external_account_id)}/#all/${encodeURIComponent(m.threadId ?? m.id)}`,
      from_address: fromList[0]?.address ?? null,
      from_name: fromList[0]?.name ?? null,
      to_recipients: parseAddressList(headers.get("to")),
      cc_recipients: parseAddressList(headers.get("cc")),
      subject: parseSubject(headers.get("subject")),
      received_at: received,
      is_read: !has("UNREAD"),
      is_starred: has("STARRED"),
      is_important: has("IMPORTANT"),
      has_attachments: /^\s*multipart\/mixed\b/i.test(headers.get("content-type") ?? ""),
      folder: has("INBOX") ? "INBOX" : null,
      labels,
      source_updated_at: received,
    };
    const first = MessageMetaSchema.safeParse(base);
    if (first.success) return first.data;
    // Sender-controlled text broke a limit: keep the message with the unusable parts dropped rather than wedge the sync.
    const second = MessageMetaSchema.safeParse({ ...base, subject: null, from_name: null, to_recipients: [], cc_recipients: [], source_url: null });
    return second.success ? second.data : null;
  }

  /** Metadata of one message; null when Gmail no longer has it (deleted between list and get). */
  async function fetchMeta(laneId: LaneId, conn: LaneBoundConnection<"google">, id: string): Promise<MessageMeta | null | "gone"> {
    try {
      const res = await deps.api.get(laneId, conn, PATH_MESSAGE, { id }, { format: "metadata", metadataHeaders: METADATA_HEADERS });
      const parsed = MetaResponseSchema.safeParse(res.data);
      if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "Gmail message metadata is not valid" });
      const meta = toMeta(conn, parsed.data);
      if (meta === null) log.child({ laneId, provider: "google", connectionId: conn.id }).warn("google.mail.message_skipped", { reason: "unusable_metadata" });
      return meta;
    } catch (e) {
      if (isConnectorError(e) && e.info.kind === "not_found") return "gone";
      throw e;
    }
  }

  async function metaFor(laneId: LaneId, conn: LaneBoundConnection<"google">, ids: readonly string[]): Promise<{ metas: MessageMeta[]; gone: string[] }> {
    const results = await mapLimit(ids, concurrency, (id) => fetchMeta(laneId, conn, id));
    const metas: MessageMeta[] = [];
    const gone: string[] = [];
    results.forEach((r, i) => {
      if (r === "gone") gone.push(ids[i] as string);
      // Trash and spam read as removed (messages.list leaves them out too); untrashing (labelRemoved) re-adds them.
      else if (r !== null && (r.labels.includes("TRASH") || r.labels.includes("SPAM"))) gone.push(ids[i] as string);
      else if (r !== null) metas.push(r);
    });
    return { metas, gone };
  }

  const done = (r: MailSyncResult): MailSyncResult => MailSyncResultSchema.parse(r);
  const resync = (): MailSyncResult => ({ upserts: [], removals: [], nextCursor: null, hasMore: false, fullResyncRequired: true });

  async function listPage(laneId: LaneId, conn: LaneBoundConnection<"google">, historyId: string, after: number, pageToken: string | null, pageSize: number): Promise<MailSyncResult> {
    const res = await deps.api.get(laneId, conn, PATH_MESSAGES, undefined, { maxResults: pageSize, q: `after:${String(after)}`, ...(pageToken ? { pageToken } : {}) });
    const list = MessageRefsSchema.safeParse(res.data);
    if (!list.success) throw new ConnectorError({ kind: "provider_error", message: "Gmail message list is not valid" });
    const { metas } = await metaFor(laneId, conn, (list.data.messages ?? []).map((x) => x.id));
    const next = list.data.nextPageToken;
    return done({
      upserts: metas,
      removals: [],
      nextCursor: cursorOf(conn.id, next ? `f:${historyId}:${String(after)}:${next}` : `h:${historyId}`),
      hasMore: next !== undefined,
      fullResyncRequired: false,
    });
  }

  async function historyPage(laneId: LaneId, conn: LaneBoundConnection<"google">, historyId: string, pageToken: string | null, pageSize: number): Promise<MailSyncResult> {
    let data: unknown;
    try {
      data = (await deps.api.get(laneId, conn, PATH_HISTORY, undefined, { startHistoryId: historyId, maxResults: pageSize, historyTypes: HISTORY_TYPES, ...(pageToken ? { pageToken } : {}) })).data;
    } catch (e) {
      // Gmail keeps history for about a week; an older (or unknown) historyId is 404: reload instead of failing.
      if (isConnectorError(e) && e.info.kind === "not_found") return resync();
      throw e;
    }
    const parsed = HistoryResponseSchema.safeParse(data);
    if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "Gmail history is not valid" });
    // The last event for an id decides: deleted -> removal, anything else -> fresh metadata.
    const last = new Map<string, "upsert" | "delete">();
    for (const rec of parsed.data.history ?? []) {
      for (const x of rec.messagesAdded ?? []) last.set(x.message.id, "upsert");
      for (const x of rec.labelsAdded ?? []) last.set(x.message.id, "upsert");
      for (const x of rec.labelsRemoved ?? []) last.set(x.message.id, "upsert");
      for (const x of rec.messagesDeleted ?? []) last.set(x.message.id, "delete");
    }
    const upsertIds = [...last].filter(([, v]) => v === "upsert").map(([k]) => k);
    const { metas, gone } = await metaFor(laneId, conn, upsertIds);
    const removals = [...new Set([...[...last].filter(([, v]) => v === "delete").map(([k]) => k), ...gone])];
    const next = parsed.data.nextPageToken;
    return done({
      upserts: metas,
      removals: removals.map((message_id) => ({ message_id })),
      nextCursor: cursorOf(conn.id, next ? `i:${historyId}:${next}` : `h:${parsed.data.historyId ?? historyId}`),
      hasMore: next !== undefined,
      fullResyncRequired: false,
    });
  }

  function checkId(id: string): void {
    if (!ProviderIdParamSchema.safeParse(id).success) throw invalid("Invalid message id");
  }

  const provider: MailProvider<"google"> = {
    provider: "google",
    capabilities,

    async sync(laneId, conn, cursor, options) {
      const c = await guard(laneId, conn, { mailbox: true });
      const opts = CommsSyncOptionsSchema.safeParse(options ?? {});
      if (!opts.success) throw invalid("Invalid sync options");
      if (cursor !== null && !CommsCursorSchema.safeParse(cursor).success) throw invalid("Invalid cursor");
      const pageSize = opts.data.pageSize ?? 100;
      if (cursor === null) {
        // Window = min(configured days, the lane policy's retention); an unreadable policy fails the sync (closed),
        // before any request to Gmail.
        const retention = await deps.laneConfig.retentionDays(laneId);
        const days = Math.min(fullDays, retention);
        const after = Math.floor((now() - days * DAY_MS) / 1000);
        const profile = ProfileSchema.safeParse((await deps.api.get(laneId, c, PATH_PROFILE)).data);
        if (!profile.success) throw new ConnectorError({ kind: "provider_error", message: "Gmail profile is not valid" });
        return listPage(laneId, c, profile.data.historyId, after, null, pageSize);
      }
      const state = parseCursor(cursor.value, c.id);
      if (state === null) return resync();
      if (state.kind === "list_page") return listPage(laneId, c, state.historyId, state.after, state.pageToken, pageSize);
      return historyPage(laneId, c, state.historyId, state.kind === "history_page" ? state.pageToken : null, pageSize);
    },

    async readBody(laneId, conn, messageId, options) {
      const c = await guard(laneId, conn, { mailbox: true });
      checkId(messageId);
      const opts = ReadBodyOptionsSchema.safeParse(options ?? {});
      if (!opts.success) throw invalid("Invalid read options");
      const res = await deps.api.get(laneId, c, PATH_MESSAGE, { id: messageId }, { format: "full" });
      const parsed = FullMessageSchema.safeParse(res.data);
      if (!parsed.success || !parsed.data.payload) throw new ConnectorError({ kind: "provider_error", message: "Gmail message is not valid" });
      const { text, contentType, truncated } = extractText(parsed.data.payload, opts.data.maxChars ?? DEFAULT_MAX_BODY_CHARS);
      return envelope(laneId, c, "mail.read_body", new UntrustedBody({ origin: "mail", text, contentType, truncated }));
    },

    async search(laneId, conn, query) {
      const c = await guard(laneId, conn, { mailbox: true });
      const q = SearchQuerySchema.safeParse(query);
      if (!q.success) throw invalid("Invalid search query");
      const res = await deps.api.get(laneId, c, PATH_MESSAGES, undefined, { q: quoteGmailQuery(q.data.query), maxResults: q.data.limit });
      const list = MessageRefsSchema.safeParse(res.data);
      if (!list.success) throw new ConnectorError({ kind: "provider_error", message: "Gmail message list is not valid" });
      const { metas } = await metaFor(laneId, c, (list.data.messages ?? []).slice(0, q.data.limit).map((x) => x.id));
      return envelope(laneId, c, "mail.search", metas);
    },

    // Gmail push (users.watch + Pub/Sub) is T-065. Until then mail is polled: no channel, no Pub/Sub resource.
    async watch(laneId, conn): Promise<WatchInfo> {
      await guard(laneId, conn);
      return { mode: "polling", resource: "mail", channel_id: null, resource_id: null, expires_at: null, created_at: new Date(now()).toISOString() };
    },
    async renew(laneId, conn): Promise<WatchInfo> {
      await guard(laneId, conn);
      return { mode: "polling", resource: "mail", channel_id: null, resource_id: null, expires_at: null, created_at: new Date(now()).toISOString() };
    },
    async stop(laneId, conn): Promise<void> {
      await guard(laneId, conn);
    },

    async prepareWrite(laneId, conn, intent): Promise<ProposedPayload<"google">> {
      const c = await guard(laneId, conn);
      const parsed = MailWriteIntentSchema.safeParse(intent);
      if (!parsed.success) throw invalid("Invalid mail write intent");
      const { action_type, compose } = parsed.data;
      // The approvals module also checks lane_config.mailboxes at propose time (T-062 follow-up); here: this connection only.
      if (compose.fromMailbox.toLowerCase() !== c.external_account_id.toLowerCase()) {
        throw new ConnectorError({ kind: "forbidden", message: "fromMailbox is not this connection's mailbox" });
      }
      return ProposedPayloadSchema.parse({
        lane_id: laneId,
        provider: "google",
        connection_id: c.id,
        action_type,
        target: { mailbox: c.external_account_id, ...(compose.inReplyTo ? { thread_id: compose.inReplyTo.threadId } : {}) },
        payload: JSON.parse(JSON.stringify(compose)) as ProposedPayload["payload"],
        payload_schema_version: EMAIL_PAYLOAD_SCHEMA_VERSION,
        expected_before: null,
      }) as ProposedPayload<"google">;
    },
  };
  return provider;
}
