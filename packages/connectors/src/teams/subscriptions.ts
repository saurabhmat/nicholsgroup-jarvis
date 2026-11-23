// Teams change-notification subscription: create, renew and stop (T-289, spec 9.1; the pattern of microsoft/subscriptions.ts, T-068). Jobs only: the one entry point is `ensure`, called by the
// conn.subscriptions_renew job (health/index.ts) for ONE Teams connection; `stop` is called by `ensure` when notices are switched off. Nothing here runs inside a user request.
//
// ONE subscription per Teams connection: `users/<entra object id>/chats/getAllMessages` (delegated, Chat.Read: all the person's chats in one), `changeType` `created` only, NO resource data
// (a notification carries ids and nothing else), a random `clientState` per subscription kept in the Vault, both URLs the server's GRAPH_NOTIFICATION_URL. NEVER a per-chat subscription: only one
// per app and chat is allowed, so two portal users in one chat would block each other (vendor facts A3). A second all-chats subscription is never created for a connection (10 per user are allowed).
//
// `ensure(laneId, conn, { now })`, per connection (the scan lists the usable Teams connections of every enabled lane):
//   1. NOTICES ARE OFF (every Teams subscription of the connection is marked removed in our records, nothing is sent to Microsoft: the guard would refuse every call, the subscription lapses on its
//      own within its expiry and the receiver drops a notification for a removed row) when: the connection is not usable; the lane has paused Teams (`teams.enabled` false, or a cloud this build does
//      not serve); the lane does not list `chat_read`; the connection does not have `teams_chat_read`; or the connection's owner no longer holds `own_mail` in the lane.
//   2. the callback URL comes from server configuration only. Not configured -> nothing is attempted, polling-free "refresh on open" stays (the normal local and preview state); if it is removed later,
//      the live subscriptions are stopped (best effort) and marked removed. Unreadable -> nothing is touched.
//   3. no live row -> create; expired -> mark removed, create; reauthorization_required -> renew; expiring within 24 hours -> renew; a renewal that answers 404 -> gone: create again.
//   4. Microsoft's answer is the lifetime that counts: the expiry it gives is recorded. An answer under 26 hours cannot be kept alive by a 12-hourly scan: the subscription is DELETED at Microsoft and
//      not recorded (or, for a renewal, marked removed), `teams.subscription.lifetime_too_short` is logged and the connection stays on "refresh on open".
//   5. a create that Microsoft REFUSES (400, 403, 404 or 501: the resource is not supported for a delegated token, the quota is used, the permission is missing) is logged as
//      `teams.subscription.unsupported` with the status and Microsoft's short error code, never thrown: notices are simply off for that connection and Settings says "Live updates unavailable". NO per-chat
//      fallback. The next scan asks again (twice a day), so a change on Microsoft's side is picked up. Any other failure (401, 429, 5xx, a timeout, a credential problem) is thrown so the job retries or reports.
// Every row is recorded BEFORE anything can act on it (the record call follows the create call at once; if recording fails the just-created subscription is stopped, best effort). Renew and stop use only
// ids returned by `store.list(laneId, connectionId)`, and the store's SQL checks (lane, connection) again. Logs carry ids, enums, a status and a minute count only: never the clientState, a token, the
// Entra object id, an address, a resource path or anything from a chat.
import { randomBytes } from "node:crypto";
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError, isConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import { assertStatusUsable } from "../contract/guards";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { SecretValue } from "../vault/secret";
import type { LaneConfigReader } from "../vault/lane-config";
import { isCloudSupported, isTenantId } from "../microsoft/constants";
import type { MicrosoftSubscriptionStore, StoredSubscription } from "../microsoft/subscription-store";
import {
  TEAMS_PROVIDER,
  TEAMS_SUBSCRIPTION_CHANGE_TYPES,
  TEAMS_SUBSCRIPTION_LIFETIME_MINUTES,
  TEAMS_SUBSCRIPTION_MIN_LIFETIME_MS,
  TEAMS_SUBSCRIPTION_RENEW_WINDOW_MS,
  TEAMS_SUBSCRIPTION_RESOURCE,
  teamsFeatureKey,
  teamsSubscriptionResource,
} from "./constants";
import type { TeamsIdentityReader } from "./guard";
import type { TeamsNoticesStore } from "./notices-store";
import type { TeamsSubscriptionClient } from "./subscription-client";

/** Bytes of randomness in a clientState: 32 (256 bits), base64url-encoded to 43 characters, well inside Graph's 128. */
export const TEAMS_CLIENT_STATE_BYTES = 32;
const DAY_MS = 86_400_000;
/** What Microsoft can answer to a refused create that means "not for this connection": the resource is not supported, the quota is used or the permission is missing. */
const REFUSED_STATUSES: readonly number[] = [400, 403, 404, 501];

/** What Graph answers to a create or a renew: only these two fields are read; the rest (which echoes our clientState) is dropped. */
const GraphSubscription = z.object({
  id: z.string().regex(/^[A-Za-z0-9_=@.+:-]{1,256}$/),
  expirationDateTime: z.iso.datetime({ offset: true }),
});

export type TeamsEnsureOutcome = {
  created: number;
  renewed: number;
  /** Subscriptions that were gone (expired or answered 404) and were created again; also counted in `created`. */
  recreated: number;
  /** Rows marked removed because notices are off for this connection, or stopped because of the lifetime rule. */
  removed: number;
  /**
   * `paused`: Teams or the chat feature is off for the lane or the connection, or the connection is not usable; `owner_not_allowed`: the owner lost `own_mail`; `not_configured`: no URL is configured
   * (live subscriptions are stopped); `config_unreadable`: nothing is touched; `unsupported`: Microsoft refused the resource; `lifetime_too_short`: Microsoft gave less than 26 hours.
   */
  skipped: "paused" | "owner_not_allowed" | "not_configured" | "config_unreadable" | "unsupported" | "lifetime_too_short" | null;
  /** The expiry of the live subscription after the run, or null when there is none. */
  expiresAt: Date | null;
};

export type TeamsSubscriptionsDeps = {
  client: TeamsSubscriptionClient;
  store: MicrosoftSubscriptionStore;
  notices: Pick<TeamsNoticesStore, "ownerStillAllowed">;
  identity: TeamsIdentityReader;
  laneConfig: Pick<LaneConfigReader, "teamsSettings">;
  /**
   * The server-configured notification URL (GRAPH_NOTIFICATION_URL: https, on the app's own origin, ending /api/webhooks/microsoft; the env schema checks it), or null when it is not set. May throw
   * when the configuration cannot be read or is invalid: that run attempts nothing, changes nothing and fails nothing.
   */
  notificationUrl: () => string | null;
  logger?: ConnectorLogger;
  /** Test hook: the random source of the clientState. */
  randomBytes?: (n: number) => Buffer;
};

export interface TeamsSubscriptions {
  ensure(laneId: LaneId, conn: LaneBoundConnection<string>, input: { now: Date }): Promise<TeamsEnsureOutcome>;
  /** Stops every live subscription of the connection: a best-effort DELETE at Graph for each, then the rows are marked removed whatever Graph answered. Returns how many rows were removed. */
  stop(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<number>;
}

const isGone = (e: unknown): boolean => isConnectorError(e) && e.info.http_status === 404;
const isRefused = (e: unknown): e is ConnectorError => isConnectorError(e) && e.info.http_status !== null && REFUSED_STATUSES.includes(e.info.http_status);
/** A provider's short error code, only when it looks like one (letters, digits, `_`, `.`, `-`): never free text. */
const safeCode = (e: ConnectorError): string | undefined => (typeof e.info.provider_error_code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(e.info.provider_error_code) ? e.info.provider_error_code : undefined);

export function createTeamsSubscriptions(deps: TeamsSubscriptionsDeps): TeamsSubscriptions {
  const log = deps.logger ?? connectorLog;
  const random = deps.randomBytes ?? randomBytes;

  async function stop(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<number> {
    assertLaneBound(laneId, conn);
    const child = log.child({ laneId, provider: TEAMS_PROVIDER, connectionId: conn.id });
    const rows = await deps.store.list(laneId, conn.id);
    for (const row of rows) {
      try {
        await deps.client.request(laneId, conn, { method: "DELETE", path: "/subscriptions/{id}", params: { id: row.subscriptionId } });
      } catch (e) {
        // Best effort: gone already (404), refused by the guard (paused), or Microsoft unreachable. The row is removed below either way, so the receiver drops what still arrives.
        child.info("teams.subscription.stop_unconfirmed", { kind: isConnectorError(e) ? e.info.kind : "unknown" });
      }
    }
    const removed = await deps.store.removeConnection(laneId, conn.id);
    child.info("teams.subscription.stopped", { count: removed });
    return removed;
  }

  /** Asks Microsoft to delete a subscription that must not stay (best effort, never throws). */
  async function stopAtMicrosoft(laneId: LaneId, conn: LaneBoundConnection<string>, subscriptionId: string): Promise<void> {
    await deps.client.request(laneId, conn, { method: "DELETE", path: "/subscriptions/{id}", params: { id: subscriptionId } }).catch(() => undefined);
  }

  /** The id and expiry Microsoft gave. Throws when the answer is not understood; `inRange` is false for a nonsense expiry (in the past, or more than 8 days ahead: the SQL bound). A too-short answer is in range: the caller applies the lifetime rule. */
  function givenExpiry(data: unknown, now: Date): { id: string; at: Date; inRange: boolean } {
    const parsed = GraphSubscription.safeParse(data);
    if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "Microsoft's answer to the subscription request was not understood" });
    const at = new Date(parsed.data.expirationDateTime);
    return { id: parsed.data.id, at, inRange: at.getTime() > now.getTime() && at.getTime() <= now.getTime() + 8 * DAY_MS };
  }
  const tooShort = (at: Date, now: Date) => at.getTime() - now.getTime() < TEAMS_SUBSCRIPTION_MIN_LIFETIME_MS;

  type CreateResult = { kind: "created"; expiresAt: Date } | { kind: "lifetime_too_short" } | { kind: "unsupported" };

  async function create(laneId: LaneId, conn: LaneBoundConnection<string>, resourcePath: string, url: string, now: Date): Promise<CreateResult> {
    const child = log.child({ laneId, provider: TEAMS_PROVIDER, connectionId: conn.id });
    const state = random(TEAMS_CLIENT_STATE_BYTES).toString("base64url");
    const clientState = new SecretValue(state); // registered with the redactor: an echo in an error or a log is scrubbed
    const asked = new Date(now.getTime() + TEAMS_SUBSCRIPTION_LIFETIME_MINUTES * 60_000);
    let data: unknown;
    try {
      // No `includeResourceData`: the client's allowed keys cannot carry it, so a notification never holds a message. `created` only.
      data = (
        await deps.client.request<unknown>(laneId, conn, {
          method: "POST",
          path: "/subscriptions",
          body: {
            changeType: TEAMS_SUBSCRIPTION_CHANGE_TYPES,
            notificationUrl: url,
            lifecycleNotificationUrl: url,
            resource: resourcePath,
            expirationDateTime: asked.toISOString(),
            clientState: clientState.reveal(),
          },
        })
      ).data;
    } catch (e) {
      if (isRefused(e)) {
        // Microsoft does not accept this subscription for this connection. No per-chat fallback: notices stay off, the page offers Refresh.
        const code = safeCode(e);
        child.warn("teams.subscription.unsupported", { status: e.info.http_status, ...(code ? { provider_error_code: code } : {}) });
        return { kind: "unsupported" };
      }
      throw e;
    }
    // (an answer that does not parse has no id to stop by: nothing is recorded, so the receiver drops what arrives, and a stray subscription lapses on its own)
    const { id, at, inRange } = givenExpiry(data, now);
    const stopCreated = () => stopAtMicrosoft(laneId, conn, id);
    if (!inRange) {
      await stopCreated();
      throw new ConnectorError({ kind: "provider_error", message: "Microsoft gave a subscription expiry outside the expected range" });
    }
    if (tooShort(at, now)) {
      await stopCreated();
      child.warn("teams.subscription.lifetime_too_short", { granted_minutes: Math.max(0, Math.floor((at.getTime() - now.getTime()) / 60_000)), asked_minutes: TEAMS_SUBSCRIPTION_LIFETIME_MINUTES });
      return { kind: "lifetime_too_short" };
    }
    try {
      await deps.store.record(laneId, { connectionId: conn.id, resource: TEAMS_SUBSCRIPTION_RESOURCE, resourcePath, subscriptionId: id, expiresAt: at, clientState });
    } catch (e) {
      await stopCreated();
      throw e;
    }
    child.info("teams.subscription.ensured", { action: "created", granted_minutes: Math.floor((at.getTime() - now.getTime()) / 60_000), asked_minutes: TEAMS_SUBSCRIPTION_LIFETIME_MINUTES });
    return { kind: "created", expiresAt: at };
  }

  type RenewResult = { kind: "renewed"; expiresAt: Date } | { kind: "lifetime_too_short" };

  async function renew(laneId: LaneId, conn: LaneBoundConnection<string>, row: StoredSubscription, now: Date): Promise<RenewResult> {
    const child = log.child({ laneId, provider: TEAMS_PROVIDER, connectionId: conn.id });
    const asked = new Date(now.getTime() + TEAMS_SUBSCRIPTION_LIFETIME_MINUTES * 60_000);
    const res = await deps.client.request<unknown>(laneId, conn, { method: "PATCH", path: "/subscriptions/{id}", params: { id: row.subscriptionId }, body: { expirationDateTime: asked.toISOString() } });
    // Graph may answer with a different value than asked (it raises a short one, caps a long one): the answer is what is recorded, never the requested expiry as if Microsoft had confirmed it.
    const { at, inRange } = givenExpiry(res.data, now);
    if (!inRange) throw new ConnectorError({ kind: "provider_error", message: "Microsoft gave a subscription expiry outside the expected range" });
    if (tooShort(at, now)) {
      await stopAtMicrosoft(laneId, conn, row.subscriptionId);
      await deps.store.mark(laneId, conn.id, row.subscriptionId, "removed");
      child.warn("teams.subscription.lifetime_too_short", { granted_minutes: Math.max(0, Math.floor((at.getTime() - now.getTime()) / 60_000)), asked_minutes: TEAMS_SUBSCRIPTION_LIFETIME_MINUTES });
      return { kind: "lifetime_too_short" };
    }
    if (!(await deps.store.renewed(laneId, conn.id, row.subscriptionId, at))) throw new ConnectorError({ kind: "not_found", message: "The subscription is no longer recorded for this connection" });
    child.info("teams.subscription.ensured", { action: "renewed", granted_minutes: Math.floor((at.getTime() - now.getTime()) / 60_000), asked_minutes: TEAMS_SUBSCRIPTION_LIFETIME_MINUTES });
    return { kind: "renewed", expiresAt: at };
  }

  async function ensure(laneId: LaneId, conn: LaneBoundConnection<string>, input: { now: Date }): Promise<TeamsEnsureOutcome> {
    assertLaneBound(laneId, conn);
    if (conn.provider !== TEAMS_PROVIDER) throw new ConnectorError({ kind: "forbidden", message: "Connection belongs to another provider" });
    const now = input.now;
    const child = log.child({ laneId, provider: TEAMS_PROVIDER, connectionId: conn.id });
    const outcome: TeamsEnsureOutcome = { created: 0, renewed: 0, recreated: 0, removed: 0, skipped: null, expiresAt: null };

    /** Notices are off for this connection: the rows are marked removed in our records and nothing is sent to Microsoft (the guard would refuse it). */
    const off = async (why: "paused" | "owner_not_allowed"): Promise<TeamsEnsureOutcome> => {
      outcome.removed = await deps.store.removeConnection(laneId, conn.id);
      outcome.skipped = why;
      if (outcome.removed > 0) child.info("teams.subscription.paused", { count: outcome.removed, reason: why });
      return outcome;
    };

    let usable = true;
    try {
      assertStatusUsable(conn.status);
    } catch {
      usable = false;
    }
    let settings;
    try {
      settings = await deps.laneConfig.teamsSettings(laneId);
    } catch {
      throw new ConnectorError({ kind: "transient", message: "The company's Teams settings could not be read" }); // retried by the job, no alert
    }
    const laneOn = settings !== null && settings.enabled && isCloudSupported(settings.cloud) && settings.features.includes("chat_read");
    const connHas = (conn.features as Record<string, unknown> | null | undefined)?.[teamsFeatureKey("chat_read")] === true;
    if (!usable || !laneOn || !connHas) return off("paused");
    // `owner lost own_mail`: asked of the database; an answer that cannot be got leaves everything as it is (retried)
    if (!(await deps.notices.ownerStillAllowed(laneId, conn.id, conn.owner_user_id ?? null))) return off("owner_not_allowed");

    let url: string | null;
    try {
      url = deps.notificationUrl();
    } catch (e) {
      // Unreadable or invalid: nothing is attempted, changed or failed. Only our own fixed text is logged (a variable name and a rule).
      outcome.skipped = "config_unreadable";
      child.warn("teams.subscription.config_unreadable", isConnectorError(e) ? { detail: e.info.message.slice(0, 200) } : {});
      return outcome;
    }
    if (url === null) {
      outcome.skipped = "not_configured";
      if ((await deps.store.list(laneId, conn.id)).length > 0) outcome.removed = await stop(laneId, conn);
      return outcome;
    }

    let identity;
    try {
      identity = await deps.identity.read(laneId, conn.id);
    } catch {
      throw new ConnectorError({ kind: "transient", message: "The Teams identity could not be read" });
    }
    const oid = typeof identity.entraObjectId === "string" ? identity.entraObjectId.toLowerCase() : null;
    if (!isTenantId(oid)) throw new ConnectorError({ kind: "connection_unavailable", message: "The Teams account's identity is not recorded; reconnect Teams" });
    const resourcePath = teamsSubscriptionResource(oid);

    const rows = (await deps.store.list(laneId, conn.id)).filter((r) => r.resource === TEAMS_SUBSCRIPTION_RESOURCE);
    const row = rows[0];
    try {
      const mark = (r: CreateResult | RenewResult): boolean => {
        if (r.kind === "created" || r.kind === "renewed") {
          outcome.expiresAt = r.expiresAt;
          return true;
        }
        outcome.skipped = r.kind;
        return false;
      };
      if (!row) {
        if (mark(await create(laneId, conn, resourcePath, url, now))) outcome.created += 1;
        return outcome;
      }
      const expired = row.expiresAt.getTime() <= now.getTime();
      const due = row.status === "reauthorization_required" || row.expiresAt.getTime() - now.getTime() <= TEAMS_SUBSCRIPTION_RENEW_WINDOW_MS;
      if (!expired && !due) {
        outcome.expiresAt = row.expiresAt;
        return outcome;
      }
      if (!expired) {
        try {
          const r = await renew(laneId, conn, row, now);
          if (mark(r)) outcome.renewed += 1;
          else outcome.removed += 1;
          return outcome;
        } catch (e) {
          if (!isGone(e) && !(isConnectorError(e) && e.info.kind === "not_found")) throw e;
        }
      }
      // Expired, or Microsoft no longer has it: the row is removed and a new subscription takes its place (still only ONE).
      await deps.store.mark(laneId, conn.id, row.subscriptionId, "removed");
      if (mark(await create(laneId, conn, resourcePath, url, now))) {
        outcome.created += 1;
        outcome.recreated += 1;
      }
      return outcome;
    } catch (e) {
      child.warn("teams.subscription.failed", { kind: isConnectorError(e) ? e.info.kind : "unknown" });
      throw e;
    }
  }

  return {
    async ensure(laneId, conn, input) {
      const outcome = await ensure(laneId, conn, input);
      return outcome;
    },
    stop,
  };
}
