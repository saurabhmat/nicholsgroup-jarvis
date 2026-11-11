// A fully wired Google connector over in-memory twins (T-063 tests only): the real OAuth provider, token manager, Gmail
// API client, mail provider and sync, with the database-backed pieces (Vault, connection rows, lane config, connect
// state, the mail index and its cursors) replaced by faithful in-memory versions, and Google replaced by the MSW fake in
// ./msw/google. The index twin keeps the SQL's rules (core.comms_mail_apply_page): lane/provider/status checked,
// removals first, an upsert replaces a row only when its source_updated_at is not older, the cursor is stored with the
// page, all or nothing. pgTAP (160_mail_sync_cursors_and_apply) pins the real function.
//
// `persistedContentWrites` is the real thing the T-062 review asked for: every write into any twin store (Vault, index,
// cursors, audit) and every log line is recorded, and the count is how many of them contain message content (the body,
// snippet or attachment canary the fake serves). A constant 0 would prove nothing.
import { randomUUID } from "node:crypto";
import type { Audit, AuditEntry } from "@nichols/core/audit";
import type { CommsContractHarness, CommsFaultKind } from "./comms-contract";
import type { CalendarSyncResult, CommsCursor, EventMeta, MailSyncResult, MessageMeta } from "../comms/schemas";
import { ACCOUNT_IN_USE_MESSAGE, ConnectorError } from "../contract/errors";
import { assertLaneBound, mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import type { Connection } from "../contract/schemas";
import { createGoogleApi } from "../google/api";
import type { CalendarIndexStore } from "../google/cal-store";
import { createCalendarSync } from "../google/cal-sync";
import { createGoogleCalendarProvider } from "../google/calendar";
import { GOOGLE_SCOPES } from "../google/constants";
import { createGoogleHttp } from "../google/http";
import { createGmailProvider } from "../google/mail";
import type { ApplyCounts } from "../google/index-rpc";
import type { MailIndexStore } from "../google/mail-store";
import { createMailSync } from "../google/mail-sync";
import { createGoogleOAuthProvider } from "../google/provider";
import { createGoogleTokenManager } from "../google/token-manager";
import { createGoogleRevoker, GOOGLE_REVOKE_ACTION } from "../google/writer";
import { computePayloadSha256 } from "../contract/writer";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { createOAuthFlow } from "../oauth/flow";
import { hashState } from "../oauth/pkce";
import type { StateStore } from "../oauth/state";
import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings } from "../vault/lane-config";
import { SecretValue } from "../vault/secret";
import type { TokenVault } from "../vault/tokens";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, GOOGLE_ATTACHMENT_CANARY, GOOGLE_BODY_CANARY, GOOGLE_SNIPPET_CANARY, READ_SCOPES, seedMessage, type FakeGoogle } from "./msw/google/handlers";

export const HARNESS_REDIRECT = "http://localhost:3000/api/connect/google/callback";
export const CONTENT_CANARIES = [GOOGLE_BODY_CANARY, GOOGLE_SNIPPET_CANARY, GOOGLE_ATTACHMENT_CANARY] as const;

type Row = { -readonly [K in keyof Connection<"google">]: Connection<"google">[K] };
type IndexRow = MessageMeta & { deleted: boolean; connection_id: string; lane_id: string };
type EventRow = EventMeta & { connection_id: string; lane_id: string };

/** The harness clock (calendar windows): the synthetic fixtures live in Oct/Nov 2026, so time stands still. */
export const HARNESS_NOW = Date.parse("2026-11-05T12:00:00.000Z");

export type GoogleHarnessOptions = {
  fake: FakeGoogle;
  /** `lane_config.mailboxes` per lane. */
  mailboxes?: Record<string, string[]>;
  /** Lanes whose policy allows email writes (`write_actions_allowed` has email_send or email_draft, T-232). Default: none. */
  composeLanes?: readonly string[];
  /** `core.lane_policies.retention_days` per lane (default 90). */
  retention?: Record<string, number>;
  /** `lane_config.calendar` per lane (default: the safe defaults); "unreadable" makes the read fail (fail-closed tests). */
  calendar?: Record<string, CalendarSettings | "unreadable">;
  now?: () => number;
};

export function createGoogleHarness(options: GoogleHarnessOptions) {
  const { fake } = options;
  const logs: LogEntry[] = [];
  const logger = createConnectorLogger({ sink: (e) => logs.push(e) });
  const audits: AuditEntry[] = [];
  const audit: Audit = {
    async log(entry) {
      audits.push(entry);
      writes.push({ store: "audit", value: entry });
    },
  };
  const writes: { store: string; value: unknown }[] = [];
  const rows = new Map<string, Row>();
  const secrets = new Map<string, string>();
  const mailboxes: Record<string, string[]> = { ...options.mailboxes };
  const stats = { tokenReads: 0, loads: 0, rotations: 0, stores: 0, revokes: 0, revokeActors: [] as (string | undefined)[] };
  let accountCounter = 0;

  const bind = (row: Row): LaneBoundConnection<"google"> => mintLaneBoundConnection<"google">({ ...row, features: { ...row.features } });
  const rowOf = (laneId: string, conn: { id: string }): Row => {
    const row = rows.get(conn.id);
    if (!row || row.lane_id !== laneId) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
    return row;
  };

  // ---- Vault twin (core.connection_token_*): lane-checked, compare-and-swap rotate.
  const vault: Pick<TokenVault, "getToken" | "storeToken" | "rotateToken" | "revokeToken"> = {
    async getToken(laneId, conn) {
      assertLaneBound(laneId, conn);
      stats.tokenReads += 1;
      const row = rowOf(laneId, conn);
      if (row.status === "disconnected") throw new ConnectorError({ kind: "connection_unavailable", message: "The connection is disconnected" });
      const text = secrets.get(row.id);
      if (text === undefined) throw new ConnectorError({ kind: "not_found", message: "No stored credential for this connection" });
      return new SecretValue(text);
    },
    async storeToken(laneId, conn, secret, expiresAt) {
      assertLaneBound(laneId, conn);
      const row = rowOf(laneId, conn);
      const holder = [...rows.values()].find(
        (r) => r.id !== row.id && r.provider === row.provider && r.external_account_id.toLowerCase() === row.external_account_id.toLowerCase() && r.status !== "disconnected" && r.status !== "pending",
      );
      if (holder) throw new ConnectorError({ kind: "forbidden", message: ACCOUNT_IN_USE_MESSAGE });
      secrets.set(row.id, secret.reveal());
      writes.push({ store: "token_store", value: "token set" }); // the token text itself is never recorded here
      row.status = "active";
      row.token_expires_at = expiresAt ? expiresAt.toISOString() : null;
      stats.stores += 1;
    },
    async rotateToken(laneId, conn, secret, expiresAt, replaces) {
      assertLaneBound(laneId, conn);
      const row = rowOf(laneId, conn);
      if (row.status === "disconnected") throw new ConnectorError({ kind: "connection_unavailable", message: "The connection is disconnected" });
      if (secrets.get(row.id) !== replaces.reveal()) return false;
      secrets.set(row.id, secret.reveal());
      writes.push({ store: "token_store", value: "token set" });
      row.token_expires_at = expiresAt ? expiresAt.toISOString() : null;
      stats.rotations += 1;
      return true;
    },
    async revokeToken(laneId, conn, actorUserId) {
      assertLaneBound(laneId, conn);
      stats.revokeActors.push(actorUserId);
      const row = rowOf(laneId, conn);
      const had = secrets.delete(row.id);
      row.status = "disconnected";
      row.token_expires_at = null;
      stats.revokes += 1;
      return had;
    },
  };

  const connections = {
    async setFeatures(laneId: string, conn: { id: string }, features: Record<string, boolean>) {
      const row = rowOf(laneId, conn);
      row.features = { ...row.features, ...features };
    },
    async ensureConnection(laneId: string, provider: string, externalAccountId: string) {
      let row = [...rows.values()].find((r) => r.lane_id === laneId && r.provider === provider && r.external_account_id === externalAccountId);
      if (!row) {
        row = {
          id: randomUUID(),
          lane_id: laneId,
          provider: provider as "google",
          external_account_id: externalAccountId,
          status: "pending",
          features: {},
          features_checked_at: null,
          token_expires_at: null,
          last_sync_at: null,
          last_error: null,
        };
        rows.set(row.id, row);
      }
      return bind(row) as LaneBoundConnection;
    },
    async load(laneId: string, id: string) {
      stats.loads += 1;
      const row = rows.get(id);
      if (!row || row.lane_id !== laneId) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
      return bind(row);
    },
  };

  const composeLanes = new Set(options.composeLanes ?? []);
  const retention: Record<string, number> = { ...options.retention };
  const calendarConfig: Record<string, CalendarSettings | "unreadable"> = { ...options.calendar };
  const clock = options.now ?? (() => HARNESS_NOW);
  const laneConfig = {
    async mailboxes(laneId: string) {
      return (mailboxes[laneId] ?? []).map((m) => m.toLowerCase());
    },
    async calendarSettings(laneId: string): Promise<CalendarSettings> {
      const c = calendarConfig[laneId];
      if (c === "unreadable") throw new ConnectorError({ kind: "transient", message: "Lane configuration unavailable" });
      return c ? { ...c } : { ...DEFAULT_CALENDAR_SETTINGS };
    },
    async retentionDays(laneId: string) {
      const days = retention[laneId] ?? 90;
      if (days < 0) throw new ConnectorError({ kind: "transient", message: "Lane policy unavailable" });
      return days;
    },
  };

  // ---- Mail index twin (comms.message_index + core.sync_cursors via core.comms_mail_apply_page).
  const index = new Map<string, IndexRow>();
  const cursors = new Map<string, string>();
  const indexKey = (laneId: string, connectionId: string, messageId: string) => `${laneId}\u0000${connectionId}\u0000${messageId}`;
  const indexStats = { applies: 0, resets: 0 };
  const store: MailIndexStore = {
    async getCursor(laneId, conn) {
      assertLaneBound(laneId, conn);
      const v = cursors.get(`${laneId}\u0000${conn.id}`);
      return v === undefined ? null : { value: v };
    },
    async resetCursor(laneId, conn) {
      assertLaneBound(laneId, conn);
      indexStats.resets += 1;
      writes.push({ store: "cursors", value: "reset" });
      cursors.delete(`${laneId}\u0000${conn.id}`);
    },
    async applyPage(laneId, conn, page: MailSyncResult, opts): Promise<ApplyCounts> {
      const stored = cursors.get(`${laneId}\u0000${conn.id}`) ?? null;
      if (stored !== (opts.expected?.value ?? null)) return { removed: 0, written: 0, skipped: 0, conflict: true };
      assertLaneBound(laneId, conn);
      const row = rowOf(laneId, conn);
      if (row.provider !== "google" || !["active", "degraded"].includes(row.status)) throw new ConnectorError({ kind: "forbidden", message: "Mail index access refused" });
      if (page.nextCursor === null) throw new ConnectorError({ kind: "invalid_input", message: "A resync answer is not a page" });
      indexStats.applies += 1;
      writes.push({ store: "message_index", value: { upserts: page.upserts, removals: page.removals } });
      writes.push({ store: "cursors", value: page.nextCursor.value });
      let removed = 0;
      for (const r of page.removals) {
        const hit = index.get(indexKey(laneId, conn.id, r.message_id));
        if (hit && !hit.deleted) {
          hit.deleted = true;
          removed += 1;
        }
      }
      const last = new Map(page.upserts.map((m) => [m.message_id, m]));
      let written = 0;
      for (const m of last.values()) {
        const k = indexKey(laneId, conn.id, m.message_id);
        const hit = index.get(k);
        const newer = !hit || hit.source_updated_at === null || (m.source_updated_at !== null && m.source_updated_at >= hit.source_updated_at);
        if (!newer) continue;
        index.set(k, { ...m, deleted: opts.revive === true ? false : (hit?.deleted ?? false), connection_id: conn.id, lane_id: laneId });
        written += 1;
      }
      cursors.set(`${laneId}\u0000${conn.id}`, page.nextCursor.value);
      if (opts?.complete) row.last_sync_at = new Date().toISOString();
      return { removed, written, skipped: last.size - written, conflict: false };
    },
  };

  // ---- Calendar index twin (cal.event_index + the 'calendar' stream via core.cal_events_apply_page).
  const events = new Map<string, EventRow>();
  const calCursorKey = (laneId: string, connectionId: string) => `${laneId}\u0000${connectionId}\u0000calendar`;
  const eventKey = (laneId: string, connectionId: string, calendarId: string, eventId: string) => `${laneId}\u0000${connectionId}\u0000${calendarId}\u0000${eventId}`;
  const calStats = { applies: 0, resets: 0 };
  const calStore: CalendarIndexStore = {
    async getCursor(laneId, conn) {
      assertLaneBound(laneId, conn);
      const v = cursors.get(calCursorKey(laneId, conn.id));
      return v === undefined ? null : { value: v };
    },
    async resetCursor(laneId, conn) {
      assertLaneBound(laneId, conn);
      calStats.resets += 1;
      writes.push({ store: "cursors", value: "reset" });
      cursors.delete(calCursorKey(laneId, conn.id));
    },
    async applyPage(laneId, conn, page: CalendarSyncResult, opts): Promise<ApplyCounts> {
      assertLaneBound(laneId, conn);
      const row = rowOf(laneId, conn);
      if (row.provider !== "google" || !["active", "degraded"].includes(row.status)) throw new ConnectorError({ kind: "forbidden", message: "Calendar index access refused" });
      const stored = cursors.get(calCursorKey(laneId, conn.id)) ?? null;
      if (stored !== (opts.expected?.value ?? null)) return { removed: 0, written: 0, skipped: 0, conflict: true };
      if (page.nextCursor === null) throw new ConnectorError({ kind: "invalid_input", message: "A resync answer is not a page" });
      calStats.applies += 1;
      writes.push({ store: "event_index", value: { upserts: page.upserts, removals: page.removals } });
      writes.push({ store: "cursors", value: page.nextCursor.value });
      // Calendars that left the selection: this lane's rows of this connection go (first, like the SQL).
      for (const k of [...events.keys()]) {
        const e = events.get(k);
        if (e && e.lane_id === laneId && e.connection_id === conn.id && (page.dropCalendars ?? []).includes(e.calendar_id)) events.delete(k);
      }
      let removed = 0;
      for (const r of page.removals) {
        const hit = events.get(eventKey(laneId, conn.id, r.calendar_id, r.event_id));
        if (hit && hit.status !== "cancelled") {
          hit.status = "cancelled";
          removed += 1;
        }
      }
      const last = new Map(page.upserts.map((e) => [eventKey(laneId, conn.id, e.calendar_id, e.event_id), e]));
      let written = 0;
      for (const [k, e] of last) {
        const hit = events.get(k);
        if (e.status === "cancelled") {
          // A stub merges status (and the version when it has one); with no stored row it inserts a stub row.
          if (!hit) {
            events.set(k, { ...e, connection_id: conn.id, lane_id: laneId });
            written += 1;
          } else if (e.source_updated_at === null || hit.source_updated_at === null || e.source_updated_at >= hit.source_updated_at) {
            hit.status = "cancelled";
            hit.source_updated_at = e.source_updated_at ?? hit.source_updated_at;
            written += 1;
          }
          continue;
        }
        // A normal event over a cancelled row needs a strictly newer version; otherwise not older.
        const newer = !hit
          ? true
          : hit.status === "cancelled"
            ? e.source_updated_at !== null && (hit.source_updated_at === null || e.source_updated_at > hit.source_updated_at)
            : hit.source_updated_at === null || (e.source_updated_at !== null && e.source_updated_at >= hit.source_updated_at);
        if (!newer) continue;
        events.set(k, { ...e, connection_id: conn.id, lane_id: laneId });
        written += 1;
      }
      cursors.set(calCursorKey(laneId, conn.id), page.nextCursor.value);
      if (opts.complete) row.last_sync_at = new Date().toISOString();
      return { removed, written, skipped: last.size - written, conflict: false };
    },
  };

  // ---- Wiring (fast HTTP: one retry, tiny backoff so a Retry-After above the cap ends retrying at once).
  const fastHttp = (laneId: string, connectionId: string | undefined, baseUrl: string) =>
    createGoogleHttp({ baseUrl, laneId, ...(connectionId ? { connectionId } : {}), retryBaseMs: 1, retryMaxMs: 5, maxRetries: 1, logger });
  const client = () => ({ clientId: FAKE_CLIENT_ID, clientSecret: new SecretValue(FAKE_CLIENT_SECRET), redirectUri: HARNESS_REDIRECT });
  const provider = createGoogleOAuthProvider({ client, laneConfig, logger, composeAllowed: async (laneId) => composeLanes.has(laneId), httpFor: (laneId, baseUrl) => fastHttp(laneId, undefined, baseUrl) });
  const newTokenManager = () =>
    createGoogleTokenManager({ vault, client, httpFor: fastHttp, logger, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))) });
  const tokens = newTokenManager();
  const api = createGoogleApi({ tokens, logger, sleep: async () => undefined, httpFor: (laneId, conn, baseUrl) => fastHttp(laneId, conn.id, baseUrl) });
  const mail = createGmailProvider({ api, connections, laneConfig, logger });
  const sync = createMailSync({ mail, store, logger });
  const calendar = createGoogleCalendarProvider({ api, connections, laneConfig, logger, now: clock });
  const calSync = createCalendarSync({ calendar, store: calStore, logger });
  const revoker = createGoogleRevoker({ vault, connections, tokens, httpFor: (laneId, baseUrl) => fastHttp(laneId, undefined, baseUrl) });

  // ---- connect state twin
  const states = new Map<string, { laneId: string; userId: string; provider: string; codeVerifier: string; redirectUri: string; expires: number }>();
  const stateStore: StateStore = {
    async create(c, laneId, prov, stateHash, codeVerifier, redirectUri) {
      states.set(stateHash, { laneId, userId: (c as unknown as { uid: string }).uid, provider: prov, codeVerifier, redirectUri, expires: Date.now() + 600_000 });
    },
    async consume(c, laneId, stateHash) {
      const s = states.get(stateHash);
      if (!s || s.laneId !== laneId || s.userId !== (c as unknown as { uid: string }).uid || s.expires <= Date.now()) return null;
      states.delete(stateHash);
      return { provider: s.provider, codeVerifier: s.codeVerifier, redirectUri: s.redirectUri };
    },
  };
  const flow = createOAuthFlow({
    providers: [provider],
    states: stateStore,
    connections,
    storeToken: (laneId, conn, secret, expiresAt) => vault.storeToken(laneId, conn, secret, expiresAt),
    audit,
    logger,
    httpFor: (_p, laneId, baseUrl) => fastHttp(laneId, undefined, baseUrl),
  });
  const as = (userId: string) => async (laneId: string) => ({ userId, client: { uid: userId, laneId } as never });
  const USER = "00000000-0000-4000-8000-0000000000a1";

  /** Connects through the real start + callback against the fake. The code is registered with the fake first. */
  async function connectViaCallback(laneId: string, opts: { email: string; code?: string; scopes?: readonly string[]; refresh?: boolean; userId?: string }) {
    const code = opts.code ?? `synthetic-google-code-${randomUUID()}`;
    fake.grant(code, { email: opts.email, scopes: opts.scopes ?? READ_SCOPES, refresh: opts.refresh ?? true });
    const userId = opts.userId ?? USER;
    const url = await flow.start("google", laneId, as(userId));
    const state = new URL(url).searchParams.get("state") ?? "";
    const result = await flow.callback("google", new URLSearchParams({ state, code }), as(userId));
    return { url, state, result };
  }

  const contentWriteCount = (): number => {
    const mentions = (v: unknown) => {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      return CONTENT_CANARIES.some((c) => text.includes(c));
    };
    return writes.filter((w) => mentions(w.value)).length + logs.filter((l) => mentions(l)).length;
  };

  /** A new active connection with a seeded fake mailbox, minted as a loader would. */
  function seedConnection(laneId: string, providerName: "google" | "microsoft", email: string): Row {
    const row: Row = {
      id: randomUUID(),
      lane_id: laneId,
      provider: providerName as "google",
      external_account_id: email,
      status: "active",
      features: {},
      features_checked_at: null,
      token_expires_at: null,
      last_sync_at: null,
      last_error: null,
    };
    rows.set(row.id, row);
    return row;
  }

  function connectGoogle(laneId: string, email: string) {
    // The mailbox is on the lane's list unless a test says otherwise (the provider re-checks the list on every call).
    const list = (mailboxes[laneId] ??= []);
    if (!list.map((m) => m.toLowerCase()).includes(email.toLowerCase())) list.push(email);
    const account = fake.accounts.get(email) ?? fake.addAccount(email);
    const row = seedConnection(laneId, "google", email);
    secrets.set(
      row.id,
      JSON.stringify({ access_token: fake.issueAccess(account), refresh_token: account.refreshToken, expires_in: 3599, scope: GOOGLE_SCOPES.join(" "), token_type: "Bearer", obtained_at: new Date().toISOString() }),
    );
    return { row, account };
  }

  const accountOf = (conn: { id: string }) => {
    const row = rows.get(conn.id);
    const account = row ? fake.accounts.get(row.external_account_id) : undefined;
    if (!account) throw new Error("unknown fake connection");
    return account;
  };

  /** The T-062 contract harness over this wiring. */
  function contractHarness(): CommsContractHarness {
    const ids = seedMessage(2, "x@example.test");
    return {
      mail,
      calendar,
      laneId: "PKG",
      otherLaneId: "APK",
      async connect(opts = {}) {
        const email = opts.mailbox ?? `exec${String(++accountCounter)}@mock-co.example.test`;
        return bind(connectGoogle(opts.laneId ?? "PKG", email).row) as never;
      },
      async connectForeignProvider() {
        const row = seedConnection("PKG", "microsoft", `foreign${String(++accountCounter)}@mock-co.example.test`);
        secrets.set(row.id, JSON.stringify({ access_token: "synthetic-foreign-access-0001", refresh_token: "synthetic-foreign-refresh-0001", obtained_at: new Date().toISOString() }));
        return mintLaneBoundConnection({ ...row, features: {} } as never) as never;
      },
      markReconnectRequired(conn) {
        const row = rows.get(conn.id);
        if (row) row.status = "reconnect_required";
      },
      injectFault(conn, kind: CommsFaultKind) {
        fake.setFault(accountOf(conn), kind, kind === "server_error" ? 2 : 1);
      },
      addMessage: (conn, id) => fake.addMessage(accountOf(conn), id),
      removeMessage: (conn) => fake.removeMessage(accountOf(conn)),
      addEvent: (conn) => fake.addEvent(accountOf(conn)),
      // Google reports a hard delete as a cancelled item, so the removed event comes back as a stub (not a removal).
      removeEvent: (conn) => {
        fake.deleteEvent(accountOf(conn), "primary", "evt-remove");
        return "evt-remove";
      },
      removedEventsAreStubs: true,
      cancelEvent: (conn) => {
        fake.cancelEvent(accountOf(conn), "primary", "evt-1");
        return "evt-1";
      },
      externalWriteCount: () => fake.state.writeRequests.length,
      externalRequestCount: () => fake.state.gmailRequests.length + fake.state.calendarRequests.length + fake.state.tokenRequests.length + fake.state.revokeRequests.length,
      tokenReads: () => stats.tokenReads,
      persistedContentWrites: contentWriteCount,
      bodyCanary: GOOGLE_BODY_CANARY,
      fixtures: { messageId: ids.id, messageSearchTerm: "budget", calendarId: "primary", calendarIds: ["primary", "c_exec_team@group.calendar.google.com", "c_ops_board@group.calendar.google.com"], eventId: "evt-1", documentId: "doc-1", documentSearchTerm: "budget" },
    };
  }

  const APPROVER = "00000000-0000-4000-8000-0000000000b1";
  const approvedRevoke = (laneId: string, conn: { id: string; external_account_id: string }, approvedBy: string = APPROVER) => {
    const action = {
      id: randomUUID(),
      lane_id: laneId,
      connection_id: conn.id,
      action_type: GOOGLE_REVOKE_ACTION,
      target: { mailbox: conn.external_account_id },
      payload: {},
      payload_schema_version: 1,
    };
    return { ...action, payload_sha256: computePayloadSha256(action), approved_by: approvedBy };
  };

  return {
    fake,
    logs,
    audits,
    writes,
    rows,
    secrets,
    mailboxes,
    retention,
    stats,
    indexStats,
    index,
    cursors,
    vault,
    connections,
    laneConfig,
    provider,
    tokens,
    newTokenManager,
    api,
    mail,
    sync,
    calendar,
    calSync,
    calStore,
    calendarConfig,
    events,
    calStats,
    store,
    revoker,
    approvedRevoke,
    flow,
    states,
    stateHash: hashState,
    as,
    bind,
    connectViaCallback,
    connectGoogle,
    contractHarness,
    contentWriteCount,
    /** Replaces the stored set with an expired-access one (same refresh token). */
    expireStoredAccess(connectionId: string) {
      const set = JSON.parse(secrets.get(connectionId) ?? "{}") as Record<string, unknown>;
      secrets.set(connectionId, JSON.stringify({ ...set, obtained_at: new Date(Date.now() - 7200_000).toISOString() }));
    },
    storedSet(connectionId: string) {
      const text = secrets.get(connectionId);
      return text === undefined ? null : (JSON.parse(text) as Record<string, unknown>);
    },
    accountOf,
  };
}

export type GoogleHarness = ReturnType<typeof createGoogleHarness>;
export type { CommsCursor };
