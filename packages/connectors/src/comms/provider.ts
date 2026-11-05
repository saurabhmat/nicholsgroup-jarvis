// Mail, calendar and document provider interfaces (T-062, architecture §6 M5/M6/M8).
//
// Implemented by Google (T-063 Gmail, T-064 Calendar, T-065 Gmail watch, T-186 Drive) and Microsoft Graph
// (T-066 to T-068, T-187). They sit beside the generic `Connector` (connect/health/disconnect stay there); these are
// the typed read and prepare surfaces the comms, calendar and documents modules call.
//
// Rules, checked by the contract suite in `@nichols/connectors/testing` (`describeCommsContract`):
// - `laneId` first, then a `LaneBoundConnection` minted by a loader. Call `assertLaneBound`, re-read the authoritative
//   row, refuse a connection of another provider with `forbidden` BEFORE any token read or request, then
//   `assertStatusUsable`. Tokens come from the Vault, never params.
// - Id parameters are validated with `ProviderIdParamSchema` (`invalid_input`) before they reach a URL.
// - Sync produces metadata only (rule 6). Content comes only from `readBody`, live, wrapped in `UntrustedBody`
//   (rule 9) inside a `SourceResult` with freshness "live", and is never persisted by the provider or the caller.
//   `maxChars` bounds how much the provider returns.
// - Failure: retries live in the HTTP client (rate limits, 5xx), not in providers. A sync that fails never advances the
//   cursor; the caller keeps the old one. An expired or foreign cursor is `fullResyncRequired`, not an error.
// - `prepareWrite` returns a `ProposedPayload` and performs no external call. There is deliberately NO execute, send,
//   create, update or delete method: execution is a `ConnectorWriter` (`@nichols/connectors/writer`) that only
//   `packages/modules/approvals` uses (rule 5).
// - `watch`/`renew`/`stop` manage the provider's own change-notification channel (like `Connector.subscribe`). Accepted
//   under rule 5 on these conditions: the callback URL/topic comes from server config only; only jobs (T-065, T-068)
//   call them; `renew` and `stop` act only on channels recorded server-side for the same (lane, connection). A real
//   provider verifies the passed `WatchInfo` against that server-side state and never trusts the caller's object alone.
import type { LaneId } from "@nichols/core";
import type { LaneBoundConnection } from "../contract/lane-bound";
import type { ProposedPayload, SourceResult } from "../contract/schemas";
import type { UntrustedBody } from "./ephemeral";
import type {
  CalendarSyncResult,
  CalendarWriteIntent,
  CommsCursor,
  CommsSyncOptions,
  DocumentLink,
  DocumentWriteIntent,
  MailSyncResult,
  MailWriteIntent,
  MessageMeta,
  ReadBodyOptions,
  SearchQuery,
  WatchInfo,
} from "./schemas";

export type CommsProviderId = "google" | "microsoft";

/** Method names a comms provider may expose. Anything else that is a function fails the contract suite. */
export const COMMS_PROVIDER_KEYS = ["provider", "capabilities", "sync", "readBody", "search", "watch", "renew", "stop", "prepareWrite"] as const;

/** Names that would amount to an execute path; never allowed on a provider (rule 5). */
export const FORBIDDEN_EXECUTE_PATTERN = /^(execute|send|create|update|delete|remove|move|decline|insert|patch|put|post|write|reply|forward|trash|archive|modify)/i;

export interface MailCapabilities {
  readonly watch: "push" | "polling";
  readonly prepareWrite: boolean;
}

export interface MailProvider<P extends CommsProviderId = CommsProviderId> {
  readonly provider: P;
  readonly capabilities: MailCapabilities;

  /**
   * Metadata delta for the connection's mailboxes (Gmail history, Graph delta per folder). `cursor: null` is a full
   * load. The cursor is per connection, opaque (a composite for Graph) and bound to the connection.
   * Removals are emitted only for true deletes (see `MessageRemovalSchema`). The caller applies a page atomically,
   * removals first, then upserts, and persists `nextCursor` only after that.
   */
  sync(laneId: LaneId, conn: LaneBoundConnection<P>, cursor: CommsCursor | null, options?: CommsSyncOptions): Promise<MailSyncResult>;

  /** Live body fetch. Returned to the caller only; never persisted, never cached by the provider. */
  readBody(laneId: LaneId, conn: LaneBoundConnection<P>, messageId: string, options?: ReadBodyOptions): Promise<SourceResult<UntrustedBody, P>>;

  /** Live provider-side search; metadata only (no snippets). `query` is plain text (see `SearchQuerySchema`). */
  search(laneId: LaneId, conn: LaneBoundConnection<P>, query: SearchQuery): Promise<SourceResult<MessageMeta[], P>>;

  watch(laneId: LaneId, conn: LaneBoundConnection<P>): Promise<WatchInfo>;
  /** Needs only the persisted `WatchInfo`; verified against server-side state for (lane, connection). */
  renew(laneId: LaneId, conn: LaneBoundConnection<P>, current: WatchInfo): Promise<WatchInfo>;
  stop(laneId: LaneId, conn: LaneBoundConnection<P>, current: WatchInfo): Promise<void>;

  /** Exact payload for `email.send` / `email.save_draft`. Never sends or saves anything. */
  prepareWrite(laneId: LaneId, conn: LaneBoundConnection<P>, intent: MailWriteIntent): Promise<ProposedPayload<P>>;
}

export interface CalendarCapabilities {
  readonly watch: "push" | "polling";
  /** False until phase 4 (T-117, T-181): `prepareWrite` then throws `unsupported_op`. */
  readonly prepareWrite: boolean;
}

export interface CalendarProvider<P extends CommsProviderId = CommsProviderId> {
  readonly provider: P;
  readonly capabilities: CalendarCapabilities;

  /**
   * Event delta across all the connection's synced calendars (Google: one syncToken per calendar inside one composite
   * cursor). Recurring events are expanded into instances; cancellations are `cancelled` upserts (merge: status only);
   * hard deletions are `removals`.
   */
  sync(laneId: LaneId, conn: LaneBoundConnection<P>, cursor: CommsCursor | null, options?: CommsSyncOptions): Promise<CalendarSyncResult>;

  /** Live event description (and nothing else). Ephemeral and untrusted, like mail bodies. */
  readBody(laneId: LaneId, conn: LaneBoundConnection<P>, calendarId: string, eventId: string, options?: ReadBodyOptions): Promise<SourceResult<UntrustedBody, P>>;

  /** One `WatchInfo` per synced calendar (push), or one polling entry. */
  watch(laneId: LaneId, conn: LaneBoundConnection<P>): Promise<WatchInfo[]>;
  renew(laneId: LaneId, conn: LaneBoundConnection<P>, current: WatchInfo): Promise<WatchInfo>;
  stop(laneId: LaneId, conn: LaneBoundConnection<P>, current: WatchInfo): Promise<void>;

  prepareWrite(laneId: LaneId, conn: LaneBoundConnection<P>, intent: CalendarWriteIntent): Promise<ProposedPayload<P>>;
}

export interface DocumentCapabilities {
  readonly prepareWrite: boolean;
}

/** Documents are live search and live read only: no sync, no watch, no metadata index (T-186, T-187). */
export interface DocumentProvider<P extends CommsProviderId = CommsProviderId> {
  readonly provider: P;
  readonly capabilities: DocumentCapabilities;

  /** Links and metadata only; no content. */
  search(laneId: LaneId, conn: LaneBoundConnection<P>, query: SearchQuery): Promise<SourceResult<DocumentLink[], P>>;

  readBody(laneId: LaneId, conn: LaneBoundConnection<P>, documentId: string, options?: ReadBodyOptions): Promise<SourceResult<UntrustedBody, P>>;

  prepareWrite(laneId: LaneId, conn: LaneBoundConnection<P>, intent: DocumentWriteIntent): Promise<ProposedPayload<P>>;
}
