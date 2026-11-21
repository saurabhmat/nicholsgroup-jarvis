// Microsoft Graph MailProvider: metadata delta sync (T-258, spec §8.1, §8.2, §8.5), and since T-259 the live body, the search and the header flags
// (spec §8.3, §8.4). The write path is T-262: `prepareWrite` answers `unsupported_op` AFTER the guard (so a refused connection is refused for the right
// reason and no request or token read happens). Read-only against Graph by construction (the Graph client has GET only).
//
// T-259: `readBody` is a live `GET /me/messages/{id}?$select=body` (text preferred; the type is read from the answer), returned in an `UntrustedBody`
// and never stored, logged or put in an error. `search` sends `$search="<plain words>"` (./mail-live.ts reduces the caller's text first, so no operator
// reaches Graph) with the index `$select` and maps the answer with the strict metadata mapper (no body, no folder). Header flags: one single-message
// read per INBOX message of a sync page (bounded, ./mail-headers.ts), booleans only; `is_auth_pass` is always false.
//
// One Graph page per `sync` call. Per folder (the lane's `microsoft.mail_folders`, well-known names resolved to ids with
// `GET /me/mailFolders/{name}`): `GET /me/mailFolders/{id}/messages/delta` with a `$select` of the index fields only and
// `$orderby=receivedDateTime desc`, and NO `$filter` (a filtered delta returns at most 5,000 messages, V-10): the folder is read in full, newest
// first, and messages older than the window (90 days or the lane's retention, whichever is shorter) are dropped by the mapper, never indexed.
// Every request, including one made from a stored link, carries `Prefer: IdType="ImmutableId", odata.maxpagesize=N` (the header applies only to
// the request it is on). Stored links are opaque and sent back unchanged, but only after validation (./mail-cursor.ts).
//
// Failure rules: 410, or a 4xx with the code `syncStateNotFound` / `resyncRequired`, on a stored link -> `fullResyncRequired` (an answer). A foreign,
// malformed or oversized cursor -> `fullResyncRequired`. Any other failure throws and never advances the cursor. Any `@removed` entry is a
// `{message_id, folder}` removal (Microsoft documents `deleted` for a delete and for a move out of the folder).
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import type { MailCapabilities, MailProvider } from "../comms/provider";
import { UntrustedBody } from "../comms/ephemeral";
import { CommsCursorSchema, CommsSyncOptionsSchema, MailSyncResultSchema, MessageMetaSchema, ProviderIdParamSchema, ReadBodyOptionsSchema, SearchQuerySchema, type MailSyncResult, type MessageMeta, type MessageRemoval, type WatchInfo } from "../comms/schemas";
import type { SourceResult } from "../contract/schemas";
import { ConnectorError, isConnectorError } from "../contract/errors";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { PROVIDER_DISABLED_MESSAGE, providerEnabledIn } from "../facade/gate";
import type { LaneConfigReader } from "../vault/lane-config";
import type { GraphApi } from "./api";
import type { MicrosoftGuard } from "./guard";
import { CANONICAL_FOLDER, encodeCursor, fingerprintOf, isFolderId, MAIL_FOLDER_NAMES, MAX_LINK_CHARS, OPTIONAL_FOLDERS, parseCursor, validateDeltaLink, type CursorState, type FolderState, type MailFolderName } from "./mail-cursor";
import { createHeaderBudget, EVENT_MESSAGE_TYPE, flagsFromAnswer, HEADER_PAGE_DEADLINE_MS, HEADER_READ_TIMEOUT_MS, HEADER_READS_PER_WINDOW, HEADERS_QUERY, type HeaderFlags } from "./mail-headers";
import { bodyFromAnswer, MAX_SEARCH_RESULTS, plainSearchWords, searchParam } from "./mail-live";
import { mapMessage, MAX_ID_CHARS } from "./mail-map";
import { INITIAL_QUERY, SELECT_PARAM } from "./mail-query";

export type MicrosoftMailDeps = {
  /** The guarded, read-only Graph client (it runs the guard again before every request attempt). */
  api: Pick<GraphApi, "get">;
  guard: MicrosoftGuard;
  /** `mailProviderSettings` (one read per call: the folders and the enabled check) and `retentionDays` (fails closed). */
  laneConfig: Pick<LaneConfigReader, "mailProviderSettings" | "retentionDays">;
  now?: () => number;
  logger?: ConnectorLogger;
  /** Upper bound on days the first load covers: min(this, the lane policy's retention_days). Default 90. */
  fullSyncDays?: number;
  /** T-259 header flags: the bounds (defaults in ./mail-headers.ts), or `false` to read no headers at all (tests of the metadata sync alone). */
  headerFlags?: false | { perWindow?: number };
  /** Header read limits (T-259): per read and per page (default 8 s and 20 s; the clock is `now`). */
  headerReadTimeoutMs?: number;
  headerPageDeadlineMs?: number;
  /** Default body length of `readBody` when the caller names none. */
  defaultMaxBodyChars?: number;
};

export const DEFAULT_FULL_SYNC_DAYS = 90;
const DAY_MS = 86_400_000;
const DEFAULT_PAGE_SIZE = 100;
/** How often a configured optional folder the mailbox did not have is looked for again. */
const ABSENT_RECHECK_MS = 60 * 60_000;
/** More items than this in one page is not a page (a provider bug or an attack); the store refuses more than 20,000 anyway. */
const MAX_PAGE_ITEMS = 2000;
const PATH_FOLDER = "/me/mailFolders/{name}";
const PATH_DELTA = "/me/mailFolders/{id}/messages/delta";
const FOLDER_QUERY = "$select=id";
const PATH_MESSAGE = "/me/messages/{id}";
const PATH_MESSAGES = "/me/messages";
/** Same default as the Gmail reader (google/constants.ts DEFAULT_MAX_BODY_CHARS). */
export const DEFAULT_MAX_BODY_CHARS = 200_000;
/** Workers for header reads (the Graph client allows this many requests in flight per mailbox). */
const HEADER_CONCURRENCY = 4;
const SINGLE_PREFER = { Prefer: 'IdType="ImmutableId"' };
const BODY_PREFER = { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' };
/**
 * Failures of ONE header read. These stop the sync (the guard, the token, the lane, the provider switch): they are OUR refusals, whatever the status.
 * `forbidden` and `invalid_input` without an HTTP status are ours too (a guard refusal, a bad path); with a status (401, 403, 400) they are Graph's answer.
 * Every other failure is soft: that message is indexed without flags, and the page is applied.
 */
const FATAL_KINDS: readonly string[] = ["reconnect_required", "connection_unavailable", "lane_mismatch", "unsupported_op"];
const FATAL_WITHOUT_STATUS: readonly string[] = ["forbidden", "invalid_input"];
/** A soft failure that says nothing about the next message (the message is gone, or its answer was unusable): the other reads of the page go on. */
const PER_MESSAGE_KINDS: readonly string[] = ["not_found", "provider_error", "invalid_input"];

const PageSchema = z.object({
  value: z.array(z.unknown()).max(MAX_PAGE_ITEMS),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});
const FolderResponseSchema = z.object({ id: z.string() });

const invalid = (message: string) => new ConnectorError({ kind: "invalid_input", message });
const providerError = (message: string) => new ConnectorError({ kind: "provider_error", message });

/** Microsoft says the delta state is gone: 410, or a 4xx with one of these codes (case-insensitive; `resyncRequired` is not documented for mail and is a harmless extra). */
export function isExpiredDeltaState(e: unknown): boolean {
  if (!isConnectorError(e)) return false;
  const { http_status: status, provider_error_code: code } = e.info;
  if (status === 410) return true;
  return status !== null && status >= 400 && status < 500 && /^(syncstatenotfound|resyncrequired)$/i.test(code ?? "");
}

const isFolderName = (n: string): n is MailFolderName => (MAIL_FOLDER_NAMES as readonly string[]).includes(n);

export function createMicrosoftMailProvider(deps: MicrosoftMailDeps): MailProvider<"microsoft"> {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? connectorLog;
  const fullDays = deps.fullSyncDays ?? DEFAULT_FULL_SYNC_DAYS;
  const capabilities: MailCapabilities = { watch: "polling", prepareWrite: false };
  const headerCfg = deps.headerFlags === false ? null : (deps.headerFlags ?? {});
  const headerReadTimeout = deps.headerReadTimeoutMs ?? HEADER_READ_TIMEOUT_MS;
  const headerDeadline = deps.headerPageDeadlineMs ?? HEADER_PAGE_DEADLINE_MS;
  const headerBudget = createHeaderBudget(now, headerCfg?.perWindow ?? HEADER_READS_PER_WINDOW);
  const defaultMaxChars = deps.defaultMaxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const envelope = <T>(laneId: LaneId, c: GuardedConn, op: string, data: T): SourceResult<T, "microsoft"> => {
    const at = new Date(now()).toISOString();
    return { lane_id: laneId, provider: "microsoft", connection_id: c.id, op, data, as_of: at, fetched_at: at, freshness: "live", provider_tid: null, source_refs: [], notes: [] };
  };

  const done = (r: MailSyncResult): MailSyncResult => MailSyncResultSchema.parse(r);
  const resync = (): MailSyncResult => ({ upserts: [], removals: [], nextCursor: null, hasMore: false, fullResyncRequired: true });
  const preferFor = (pageSize: number) => ({ Prefer: `IdType="ImmutableId", odata.maxpagesize=${String(pageSize)}` });

  type GuardedConn = Awaited<ReturnType<MicrosoftGuard>>["conn"];
  const unsupported = (what: string) => new ConnectorError({ kind: "unsupported_op", message: `${what} is not available for Microsoft yet` });
  const pollingWatch = (): WatchInfo => ({ mode: "polling", resource: "mail", channel_id: null, resource_id: null, expires_at: null, created_at: new Date(now()).toISOString() });

  /** Resolves one well-known folder to its Graph id. */
  async function resolveFolderId(laneId: LaneId, conn: unknown, name: MailFolderName, pageSize: number): Promise<string> {
    const res = await deps.api.get(laneId, conn, PATH_FOLDER, { name }, undefined, { headers: preferFor(pageSize), rawQuery: FOLDER_QUERY });
    const parsed = FolderResponseSchema.safeParse(res.data);
    if (!parsed.success || !isFolderId(parsed.data.id)) throw providerError("Microsoft mail folder is not valid");
    return parsed.data.id;
  }

  /** Window start for a folder that is about to be loaded: min(configured days, the lane policy's retention); an unreadable policy fails the sync (closed). */
  async function windowStart(laneId: LaneId): Promise<string> {
    const retention = await deps.laneConfig.retentionDays(laneId);
    const days = Math.min(fullDays, retention);
    return new Date(now() - days * DAY_MS).toISOString();
  }

  /**
   * Fresh discovery (first load, the folder settings changed, a stored folder id stopped answering, or the hourly re-check of an absent optional folder): every
   * configured folder's id is resolved. A folder that was already in the cursor with the same id keeps its link and window; a new one starts a full load.
   * An OPTIONAL folder (`archive`) the mailbox does not have (404 on the lookup) is left out and recorded as absent, so it is looked for again later and never
   * stops the other folders; a 404 for `inbox` or `sentitems` stays a hard failure.
   */
  async function discover(laneId: LaneId, conn: unknown, names: readonly MailFolderName[], fp: string, previous: CursorState | null, pageSize: number): Promise<CursorState> {
    let since: string | null = null;
    const folders: FolderState[] = [];
    const absent: MailFolderName[] = [];
    for (const name of names) {
      let id: string;
      try {
        id = await resolveFolderId(laneId, conn, name, pageSize);
      } catch (e) {
        if (OPTIONAL_FOLDERS.includes(name) && isConnectorError(e) && e.info.http_status === 404) {
          absent.push(name);
          continue;
        }
        throw e;
      }
      const kept = previous?.folders.find((f) => f.name === name && f.id === id);
      if (kept) {
        folders.push(kept);
        continue;
      }
      since ??= await windowStart(laneId);
      folders.push({ name, id, since });
    }
    if (folders.length === 0) throw providerError("This mailbox has none of the configured mail folders");
    if (absent.length > 0) log.child({ laneId, provider: "microsoft" }).info("microsoft.mail.folders_absent", { count: absent.length, configured: names.length });
    return { v: 1, folders, pos: 0, fp, ...(absent.length > 0 ? { absent, checked: new Date(now()).toISOString() } : {}) };
  }

  /**
   * Header flags of the INBOX messages of a page (newest first): one read per message of the page (`pageSize` of them at most, so a first load flags the
   * whole page), within the connection's window budget. Each read has a short timeout and no retries, and the page has a deadline after which the rest are
   * skipped exactly like a stop. A read that fails because Graph answered or timed out leaves that message without flags (see FATAL_KINDS); a failure
   * that says nothing about the others (404, an unusable answer) lets the rest go on, any other soft failure stops the remaining reads of this page; the
   * page is still applied. A refusal of OURS (reconnect required, provider disabled, a guard or token failure) is thrown and fails the page: the cursor
   * does not advance. Reads granted but never started are given back to the budget. Nothing of an answer is logged: counts only.
   */
  async function readHeaderFlags(laneId: LaneId, c: GuardedConn, metas: readonly MessageMeta[], pageSize: number): Promise<Map<string, HeaderFlags>> {
    const out = new Map<string, HeaderFlags>();
    if (headerCfg === null || metas.length === 0) return out;
    const seen = new Set<string>();
    const ids = [...metas]
      .sort((a, b) => (a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0))
      .map((m) => m.message_id)
      .filter((id) => !seen.has(id) && ProviderIdParamSchema.safeParse(id).success && (seen.add(id), true));
    const granted = headerBudget.take(laneId, c.id, Math.min(pageSize, ids.length));
    const todo = ids.slice(0, granted);
    const deadline = now() + headerDeadline;
    let next = 0;
    let started = 0;
    let stop = false;
    let failed = 0;
    let fatal: { error: unknown } | null = null;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stop || now() >= deadline) return;
        const i = next++;
        if (i >= todo.length) return;
        const id = todo[i] as string;
        started += 1;
        try {
          const res = await deps.api.get(laneId, c, PATH_MESSAGE, { id }, undefined, { headers: SINGLE_PREFER, rawQuery: HEADERS_QUERY, timeoutMs: headerReadTimeout, noRetry: true });
          const flags = flagsFromAnswer(res.data);
          if (flags) out.set(id, flags);
          else failed += 1;
        } catch (e) {
          const info = isConnectorError(e) ? e.info : null;
          if (info === null || FATAL_KINDS.includes(info.kind) || (info.http_status === null && FATAL_WITHOUT_STATUS.includes(info.kind))) {
            fatal ??= { error: e };
            stop = true;
            return;
          }
          failed += 1;
          if (!PER_MESSAGE_KINDS.includes(info.kind) || info.http_status === 401 || info.http_status === 403) stop = true; // throttled, unavailable, timed out, refused: the rest of this page is left without flags
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(HEADER_CONCURRENCY, todo.length) }, worker));
    headerBudget.refund(laneId, c.id, todo.length - started);
    if (fatal !== null) throw (fatal as { error: unknown }).error;
    const notRead = ids.length - out.size - failed; // over the budget, or left after a stop or the deadline
    if (failed > 0 || notRead > 0) log.child({ laneId, provider: "microsoft", connectionId: c.id }).info("microsoft.mail.header_flags_partial", { read: out.size, failed, notRead });
    return out;
  }

  async function syncPage(laneId: LaneId, conn: Parameters<MicrosoftGuard>[1], cursor: Parameters<MailProvider<"microsoft">["sync"]>[2], options: Parameters<MailProvider<"microsoft">["sync"]>[3]): Promise<MailSyncResult> {
    const g = await deps.guard(laneId, conn); // lane, provider, status, tenant, cloud, mail policy: before anything is read or requested
    const c = g.conn;
    const opts = CommsSyncOptionsSchema.safeParse(options ?? {});
    if (!opts.success) throw invalid("Invalid sync options");
    if (cursor !== null && !CommsCursorSchema.safeParse(cursor).success) throw invalid("Invalid cursor");
    const pageSize = opts.data.pageSize ?? DEFAULT_PAGE_SIZE;

    // One settings read for this call: the lane's folders, and the enabled check again (the guard decided from its own read).
    const settings = await deps.laneConfig.mailProviderSettings(laneId);
    if (!providerEnabledIn(settings, "microsoft") || !settings.microsoft) throw new ConnectorError({ kind: "connection_unavailable", message: PROVIDER_DISABLED_MESSAGE });
    if (g.cloud !== "commercial") throw new ConnectorError({ kind: "unsupported_op", message: "This Microsoft cloud is not supported yet" });
    const names = settings.microsoft.mailFolders.filter(isFolderName);
    if (names.length === 0) throw providerError("No mail folders are configured");
    const fp = fingerprintOf(names);

    let state: CursorState | null = null;
    if (cursor !== null) {
      state = parseCursor(cursor.value, c.id);
      if (state === null) return resync(); // foreign, malformed, oversized, or a link that fails validation
    }
    // An absent optional folder is looked for again at the start of a cycle (position 0, no page in progress), at most once an hour.
    const recheckDue = state !== null && state.absent !== undefined && state.pos === 0 && state.folders[0]?.next === undefined && now() - Date.parse(state.checked as string) >= ABSENT_RECHECK_MS;
    const discoveredNow = state === null || state.fp !== fp || recheckDue;
    if (discoveredNow) state = await discover(laneId, c, names, fp, state, pageSize);
    state = state as CursorState;

    const folder = state.folders[state.pos] as FolderState;
    const stored = folder.next ?? folder.delta;
    const rawQuery = stored === undefined ? INITIAL_QUERY : (validateDeltaLink(stored, folder.id)?.query ?? null);
    if (rawQuery === null) return resync();

    let data: unknown;
    try {
      data = (await deps.api.get(laneId, c, PATH_DELTA, { id: folder.id }, undefined, { headers: preferFor(pageSize), rawQuery })).data;
    } catch (e) {
      // Only a STORED link can be expired; the first request of a load is never answered with a resync (it would loop).
      if (stored !== undefined && isExpiredDeltaState(e)) {
        log.child({ laneId, provider: "microsoft", connectionId: c.id }).warn("microsoft.mail.delta_state_expired", { folder: folder.name });
        return resync();
      }
      // A folder id from the cursor that no longer exists (the folder was deleted or recreated): start from a fresh discovery instead of failing forever.
      // A folder id resolved in THIS call that answers 404 is a real failure.
      if (!discoveredNow && isConnectorError(e) && e.info.http_status === 404) {
        log.child({ laneId, provider: "microsoft", connectionId: c.id }).warn("microsoft.mail.folder_id_stale", { folder: folder.name });
        return resync();
      }
      throw e;
    }
    const page = PageSchema.safeParse(data);
    if (!page.success) throw providerError("Microsoft message delta is not valid");
    const next = page.data["@odata.nextLink"];
    const delta = page.data["@odata.deltaLink"];
    if ((next === undefined) === (delta === undefined)) throw providerError("Microsoft message delta is not valid"); // exactly one of the two ends a page

    let upserts: MessageMeta[] = [];
    const removals: MessageRemoval[] = [];
    const canonical = CANONICAL_FOLDER[folder.name];
    let old = 0;
    let unusable = 0;
    for (const item of page.data.value) {
      if (typeof item === "object" && item !== null && "@removed" in item) {
        // Any `@removed` (documented `deleted`, for a delete and for a move out of this folder) removes the row of THIS folder only.
        const id = (item as { id?: unknown }).id;
        if (typeof id === "string" && id !== "" && id.length <= MAX_ID_CHARS && !/[\u0000-\u001f\u007f-\u009f]/.test(id)) removals.push({ message_id: id, folder: canonical });
        else unusable += 1;
        continue;
      }
      const r = mapMessage(item, { folder: folder.name, since: folder.since, cloud: g.cloud });
      // A meeting request, cancellation or response is an `eventMessage` (spec §8.4): the type is used when Graph returns it in the delta item.
      const isEvent = typeof item === "object" && item !== null && (item as { "@odata.type"?: unknown })["@odata.type"] === EVENT_MESSAGE_TYPE;
      if ("meta" in r) upserts.push(isEvent ? { ...r.meta, is_calendar: true } : r.meta);
      else if (r.dropped === "old") old += 1;
      else unusable += 1;
    }
    if (old > 0 || unusable > 0) log.child({ laneId, provider: "microsoft", connectionId: c.id }).info("microsoft.mail.items_dropped", { folder: folder.name, old, unusable });

    // A nextLink equal to the link just used would page the same data forever, run after run: refuse it.
    if (next !== undefined && next === stored) throw providerError("Microsoft returned the same page link again");
    // The new state: the link of this page, and the position.
    const link = (next ?? delta) as string;
    if (link.length > MAX_LINK_CHARS) return resync(); // too long for the cursor: fail safe, never truncated
    if (validateDeltaLink(link, folder.id) === null) throw providerError("Microsoft returned a link that cannot be used");
    const updated: FolderState = { name: folder.name, id: folder.id, since: folder.since, ...(next !== undefined ? { next } : { delta }) };
    const folders = state.folders.map((f, i) => (i === state.pos ? updated : f));
    let pos = state.pos;
    let hasMore = true;
    if (next === undefined) {
      pos = state.pos + 1;
      if (pos >= folders.length) {
        pos = 0;
        hasMore = false;
      }
    }
    const nextCursor = encodeCursor(c.id, { v: 1, folders, pos, fp, ...(state.absent !== undefined && state.checked !== undefined ? { absent: state.absent, checked: state.checked } : {}) });
    if (nextCursor === null) return resync(); // the state would not fit the table's limit: fail safe
    // Header flags (inbox only; one bounded single-message read each). AFTER every check that can refuse the page (link, cursor), so a refused page costs no read. Only the booleans are kept; is_auth_pass is false.
    if (folder.name === "inbox" && upserts.length > 0) {
      const flags = await readHeaderFlags(laneId, c, upserts, pageSize);
      if (flags.size > 0) upserts = upserts.map((m) => { const f = flags.get(m.message_id); return f ? { ...m, ...f, is_calendar: f.is_calendar || m.is_calendar === true } : m; });
    }

    return done({ upserts, removals, nextCursor, hasMore, fullResyncRequired: false });
  }

  const provider: MailProvider<"microsoft"> = {
    provider: "microsoft",
    capabilities,

    sync: (laneId, conn, cursor, options) => syncPage(laneId, conn, cursor, options),

    async readBody(laneId, conn, messageId, options) {
      const g = await deps.guard(laneId, conn); // before the id is looked at and before any token read
      const id = ProviderIdParamSchema.safeParse(messageId);
      if (!id.success) throw invalid("Invalid message id"); // fixed text: the id is never echoed; checked before any request
      const opts = ReadBodyOptionsSchema.safeParse(options ?? {});
      if (!opts.success) throw invalid("Invalid read options");
      if (g.cloud !== "commercial") throw new ConnectorError({ kind: "unsupported_op", message: "This Microsoft cloud is not supported yet" });
      const res = await deps.api.get(laneId, g.conn, PATH_MESSAGE, { id: id.data }, undefined, { headers: BODY_PREFER, rawQuery: "$select=body" });
      const body = bodyFromAnswer(res.data, opts.data.maxChars ?? defaultMaxChars);
      if (body === null) throw providerError("Microsoft message body is not valid"); // never the content
      return envelope(laneId, g.conn, "mail.read_body", new UntrustedBody({ origin: "mail", text: body.text, contentType: "text/plain", truncated: body.truncated }));
    },
    async search(laneId, conn, query) {
      const g = await deps.guard(laneId, conn);
      const q = SearchQuerySchema.safeParse(query);
      if (!q.success) throw invalid("Invalid search query");
      const words = plainSearchWords(q.data.query);
      if (words === null) throw invalid("The search has no words to look for");
      if (g.cloud !== "commercial") throw new ConnectorError({ kind: "unsupported_op", message: "This Microsoft cloud is not supported yet" });
      const limit = Math.min(q.data.limit, MAX_SEARCH_RESULTS);
      // The index fields only (no body), the quoted plain words, a bounded count; no $filter and no $orderby (Graph sorts a search itself).
      const rawQuery = `${SELECT_PARAM}&${searchParam(words)}&$top=${String(limit)}`;
      const res = await deps.api.get(laneId, g.conn, PATH_MESSAGES, undefined, undefined, { headers: { Prefer: 'IdType="ImmutableId"' }, rawQuery });
      const page = z.object({ value: z.array(z.unknown()).max(MAX_PAGE_ITEMS) }).safeParse(res.data);
      if (!page.success) throw providerError("Microsoft search answer is not valid");
      // Results are untrusted data (rule 9): strict, metadata only (the mapper drops body, preview and headers), no folder (the select has none, so none is guessed).
      const metas: MessageMeta[] = [];
      const seen = new Set<string>();
      for (const item of page.data.value) {
        if (metas.length >= limit) break;
        const r = mapMessage(item, { folder: "inbox", since: new Date(0).toISOString(), cloud: g.cloud });
        if (!("meta" in r) || seen.has(r.meta.message_id)) continue;
        seen.add(r.meta.message_id);
        metas.push(MessageMetaSchema.parse({ ...r.meta, folder: null }));
      }
      return envelope(laneId, g.conn, "mail.search", metas);
    },
    // Graph change notifications are T-068 / T-264: until then mail is polled, no subscription is created.
    async watch(laneId, conn) {
      await deps.guard(laneId, conn);
      return pollingWatch();
    },
    async renew(laneId, conn) {
      await deps.guard(laneId, conn);
      return pollingWatch();
    },
    async stop(laneId, conn) {
      await deps.guard(laneId, conn);
    },
    // T-262: the write path.
    async prepareWrite(laneId, conn) {
      await deps.guard(laneId, conn);
      throw unsupported("Preparing an email write");
    },
  };
  return provider;
}

