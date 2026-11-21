// Microsoft Graph MailProvider (T-258): metadata delta sync only (spec §8.1, §8.2, §8.5). Live body, search and header flags are T-259, the
// write path T-262; those methods answer `unsupported_op` AFTER the guard (so a refused connection is refused for the right reason and no
// request or token read happens). Read-only against Graph by construction (the Graph client has GET only).
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
import { CommsCursorSchema, CommsSyncOptionsSchema, MailSyncResultSchema, type MailSyncResult, type MessageMeta, type MessageRemoval, type WatchInfo } from "../comms/schemas";
import { ConnectorError, isConnectorError } from "../contract/errors";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { PROVIDER_DISABLED_MESSAGE, providerEnabledIn } from "../facade/gate";
import type { LaneConfigReader } from "../vault/lane-config";
import type { GraphApi } from "./api";
import type { MicrosoftGuard } from "./guard";
import { CANONICAL_FOLDER, encodeCursor, fingerprintOf, isFolderId, MAIL_FOLDER_NAMES, MAX_LINK_CHARS, parseCursor, validateDeltaLink, type CursorState, type FolderState, type MailFolderName } from "./mail-cursor";
import { mapMessage, MAX_ID_CHARS, MESSAGE_SELECT } from "./mail-map";

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
};

export const DEFAULT_FULL_SYNC_DAYS = 90;
const DAY_MS = 86_400_000;
const DEFAULT_PAGE_SIZE = 100;
/** More items than this in one page is not a page (a provider bug or an attack); the store refuses more than 20,000 anyway. */
const MAX_PAGE_ITEMS = 2000;
const PATH_FOLDER = "/me/mailFolders/{name}";
const PATH_DELTA = "/me/mailFolders/{id}/messages/delta";
/** The first delta request: index fields only, newest first, NO `$filter`. Sent as a raw query so `$` and the space go out as Graph documents them. */
const INITIAL_QUERY = `$select=${MESSAGE_SELECT.join(",")}&$orderby=receivedDateTime%20desc`;
const FOLDER_QUERY = "$select=id";

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

  const done = (r: MailSyncResult): MailSyncResult => MailSyncResultSchema.parse(r);
  const resync = (): MailSyncResult => ({ upserts: [], removals: [], nextCursor: null, hasMore: false, fullResyncRequired: true });
  const preferFor = (pageSize: number) => ({ Prefer: `IdType="ImmutableId", odata.maxpagesize=${String(pageSize)}` });

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
   * Fresh discovery (first load, or the folder settings changed): every configured folder's id is resolved. A folder that was already in the
   * cursor with the same id keeps its link and window; a new one starts a full load.
   */
  async function discover(laneId: LaneId, conn: unknown, names: readonly MailFolderName[], fp: string, previous: CursorState | null, pageSize: number): Promise<CursorState> {
    let since: string | null = null;
    const folders: FolderState[] = [];
    for (const name of names) {
      const id = await resolveFolderId(laneId, conn, name, pageSize);
      const kept = previous?.folders.find((f) => f.name === name && f.id === id);
      if (kept) {
        folders.push(kept);
        continue;
      }
      since ??= await windowStart(laneId);
      folders.push({ name, id, since });
    }
    return { v: 1, folders, pos: 0, fp };
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
    if (state === null || state.fp !== fp) state = await discover(laneId, c, names, fp, state, pageSize);

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
      throw e;
    }
    const page = PageSchema.safeParse(data);
    if (!page.success) throw providerError("Microsoft message delta is not valid");
    const next = page.data["@odata.nextLink"];
    const delta = page.data["@odata.deltaLink"];
    if ((next === undefined) === (delta === undefined)) throw providerError("Microsoft message delta is not valid"); // exactly one of the two ends a page

    const upserts: MessageMeta[] = [];
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
      if ("meta" in r) upserts.push(r.meta);
      else if (r.dropped === "old") old += 1;
      else unusable += 1;
    }
    if (old > 0 || unusable > 0) log.child({ laneId, provider: "microsoft", connectionId: c.id }).info("microsoft.mail.items_dropped", { folder: folder.name, old, unusable });

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
    const nextCursor = encodeCursor(c.id, { v: 1, folders, pos, fp });
    if (nextCursor === null) return resync(); // the state would not fit the table's limit: fail safe
    return done({ upserts, removals, nextCursor, hasMore, fullResyncRequired: false });
  }

  const provider: MailProvider<"microsoft"> = {
    provider: "microsoft",
    capabilities,

    sync: (laneId, conn, cursor, options) => syncPage(laneId, conn, cursor, options),

    // T-259: live body, search and header flags. Guarded first, then refused: no request, no token read.
    async readBody(laneId, conn) {
      await deps.guard(laneId, conn);
      throw unsupported("Reading a message");
    },
    async search(laneId, conn) {
      await deps.guard(laneId, conn);
      throw unsupported("Mail search");
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

