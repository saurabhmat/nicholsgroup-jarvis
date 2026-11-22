// Microsoft change-notification subscriptions: create (watch), renew and stop (T-068, T-264, spec §14). Jobs only: the one entry point is `ensure`, called by the T-040 renewal job
// (conn.subscriptions_renew, health/index.ts) for ONE connection; `stop` is called by `ensure` when notifications are switched off. Nothing here runs inside a user request.
//
// `ensure(laneId, conn, { now })`, per connection (the scan lists usable Microsoft connections of every enabled lane):
//   1. the provider must be enabled for the lane (one `mailProviderSettings` read, the same decision as the guard and the health skip). When it is not (paused), every subscription of the
//      connection is marked removed and nothing is sent to Microsoft (the guard would refuse every call; the subscription lapses on its own within the expiry, and the receiver drops
//      notifications for a removed row). Nothing else about the connection changes.
//   2. the callback URL comes from server configuration only (GRAPH_NOTIFICATION_URL through `notificationUrl()`), never from a request. Not configured -> NO subscription is attempted,
//      polling stays, nothing fails and no alert is raised (the normal local and preview state). If the variable is removed later, the live subscriptions are stopped (best effort) and marked
//      removed: that is how change notifications are switched off.
//   3. for each stream (mail: the inbox; calendar: `me/events`, D-59: the default calendar) of the connection:
//        no live row               -> create (POST /subscriptions), then record it (the clientState, a random Vault secret, never logged)
//        expired                   -> the row is marked removed and a new subscription is created (Graph would answer 404 to a renewal)
//        reauthorization_required  -> renew (PATCH the expiry)
//        expires within 24 hours   -> renew
//        a renewal that answers 404 -> gone: marked removed, a new subscription is created
//      A failure of one stream does not stop the other; the first failure is thrown at the end, so the job reports it (a retryable one is retried, a permanent one raises
//      `subscription_renewal_failed`). Polling is never touched: a connection whose subscription failed simply keeps its 15-minute sync.
// Every row is recorded BEFORE anything can act on it (the record call follows the create call at once; if recording fails the just-created subscription is stopped, best effort).
// Renew and stop use only ids returned by `store.list(laneId, connectionId)`, and the store's SQL checks (lane, connection) again, so they can only touch a subscription recorded for
// the same connection. Logs carry ids, enums and counts only: never the clientState, a token, an address or a resource path.
import { randomBytes } from "node:crypto";
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError, isConnectorError } from "../contract/errors";
import type { WatchInfo } from "../comms/schemas";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import { providerEnabledIn } from "../facade/gate";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { SecretValue } from "../vault/secret";
import type { LaneConfigReader } from "../vault/lane-config";
import { isCloudSupported, SUBSCRIPTION_CHANGE_TYPES, SUBSCRIPTION_LIFETIME_MINUTES, SUBSCRIPTION_RENEW_WINDOW_MS, SUBSCRIPTION_RESOURCES, type SubscriptionResource } from "./constants";
import type { GraphSubscriptionClient } from "./subscription-client";
import type { MicrosoftSubscriptionStore, StoredSubscription } from "./subscription-store";

const STREAMS: readonly SubscriptionResource[] = ["mail", "calendar"];
/** Bytes of randomness in a clientState: 32 (256 bits), base64url-encoded to 43 characters, well inside Graph's 128. */
export const CLIENT_STATE_BYTES = 32;
const DAY_MS = 86_400_000;

/** What Graph answers to a create or a renew: only these two fields are read; the rest (which echoes our clientState) is dropped. */
const GraphSubscription = z.object({
  id: z.string().regex(/^[A-Za-z0-9_=@.+:-]{1,256}$/),
  expirationDateTime: z.iso.datetime({ offset: true }),
});

export type EnsureOutcome = {
  created: number;
  renewed: number;
  /** Subscriptions that were gone (expired or answered 404) and were created again; also counted in `created`. */
  recreated: number;
  /** Rows marked removed because the provider is paused or notifications were switched off. */
  removed: number;
  /** `not_configured`: no URL is configured (live subscriptions are stopped); `config_unreadable`: the configuration could not be read this run (nothing is touched); `provider_disabled`: paused. */
  skipped: "not_configured" | "config_unreadable" | "provider_disabled" | null;
  /** The earliest expiry among the live subscriptions after the run, or null when there are none. */
  expiresAt: Date | null;
};

export type MicrosoftSubscriptionsDeps = {
  client: GraphSubscriptionClient;
  store: MicrosoftSubscriptionStore;
  laneConfig: Pick<LaneConfigReader, "mailProviderSettings">;
  /**
   * The server-configured notification URL (GRAPH_NOTIFICATION_URL: https, on the app's own origin, ending /api/webhooks/microsoft; the env schema checks it), or null when it is not
   * set. May throw when the configuration cannot be read or is invalid (a missing client secret, a malformed URL): that run attempts nothing, changes nothing and fails nothing.
   */
  notificationUrl: () => string | null;
  logger?: ConnectorLogger;
  /** Test hook: the random source of the clientState. */
  randomBytes?: (n: number) => Buffer;
};

export interface MicrosoftSubscriptions {
  ensure(laneId: LaneId, conn: LaneBoundConnection<string>, input: { now: Date }): Promise<EnsureOutcome>;
  /** Stops every live subscription of the connection: a best-effort DELETE at Graph for each, then the rows are marked removed whatever Graph answered. Returns how many rows were removed. */
  stop(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<number>;
  /** The `WatchInfo` of one stream from our own record: `push` with the expiry while a live subscription exists, `polling` otherwise. Reads no Graph state. */
  watchInfo(laneId: LaneId, conn: LaneBoundConnection<string>, resource: SubscriptionResource, now: Date): Promise<WatchInfo>;
}

const isGone = (e: unknown): boolean => isConnectorError(e) && e.info.http_status === 404;

export function createMicrosoftSubscriptions(deps: MicrosoftSubscriptionsDeps): MicrosoftSubscriptions {
  const log = deps.logger ?? connectorLog;
  const random = deps.randomBytes ?? randomBytes;

  async function stop(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<number> {
    assertLaneBound(laneId, conn);
    const child = log.child({ laneId, provider: "microsoft", connectionId: conn.id });
    const rows = await deps.store.list(laneId, conn.id);
    for (const row of rows) {
      try {
        await deps.client.request(laneId, conn, { method: "DELETE", path: "/subscriptions/{id}", params: { id: row.subscriptionId } });
      } catch (e) {
        // Best effort: gone already (404), refused by the guard, or Microsoft unreachable. The row is removed below either way, so the receiver drops what still arrives.
        child.info("microsoft.subscription.stop_unconfirmed", { resource: row.resource, kind: isConnectorError(e) ? e.info.kind : "unknown" });
      }
    }
    const removed = await deps.store.removeConnection(laneId, conn.id);
    child.info("microsoft.subscription.stopped", { count: removed });
    return removed;
  }

  async function create(laneId: LaneId, conn: LaneBoundConnection<string>, resource: SubscriptionResource, url: string, now: Date): Promise<Date> {
    const state = random(CLIENT_STATE_BYTES).toString("base64url");
    const clientState = new SecretValue(state); // registered with the redactor: an echo in an error or a log is scrubbed
    const expires = new Date(now.getTime() + SUBSCRIPTION_LIFETIME_MINUTES * 60_000);
    const res = await deps.client.request<unknown>(laneId, conn, {
      method: "POST",
      path: "/subscriptions",
      // No `includeResourceData`: the client's allowed keys cannot carry it, so a notification never holds mail or event content.
      body: {
        changeType: SUBSCRIPTION_CHANGE_TYPES,
        notificationUrl: url,
        lifecycleNotificationUrl: url,
        resource: SUBSCRIPTION_RESOURCES[resource],
        expirationDateTime: expires.toISOString(),
        clientState: clientState.reveal(),
      },
    });
    const parsed = GraphSubscription.safeParse(res.data);
    if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "Microsoft's answer to the subscription request was not understood" });
    const expiresAt = new Date(parsed.data.expirationDateTime);
    const stopCreated = async () => {
      // The subscription exists at Microsoft but could not be recorded: stop it, so nothing is delivered for a subscription no row describes.
      await deps.client.request(laneId, conn, { method: "DELETE", path: "/subscriptions/{id}", params: { id: parsed.data.id } }).catch(() => undefined);
    };
    if (!(expiresAt.getTime() > now.getTime()) || expiresAt.getTime() > now.getTime() + 8 * DAY_MS) {
      await stopCreated();
      throw new ConnectorError({ kind: "provider_error", message: "Microsoft gave a subscription expiry outside the expected range" });
    }
    try {
      await deps.store.record(laneId, { connectionId: conn.id, resource, subscriptionId: parsed.data.id, expiresAt, clientState });
    } catch (e) {
      await stopCreated();
      throw e;
    }
    return expiresAt;
  }

  async function renew(laneId: LaneId, conn: LaneBoundConnection<string>, row: StoredSubscription, now: Date): Promise<Date> {
    const expires = new Date(now.getTime() + SUBSCRIPTION_LIFETIME_MINUTES * 60_000);
    const res = await deps.client.request<unknown>(laneId, conn, { method: "PATCH", path: "/subscriptions/{id}", params: { id: row.subscriptionId }, body: { expirationDateTime: expires.toISOString() } });
    const parsed = GraphSubscription.safeParse(res.data);
    // Graph may answer with a different value than asked (it raises a short one, caps a long one): the answer is what is recorded.
    const at = parsed.success ? new Date(parsed.data.expirationDateTime) : expires;
    if (!(at.getTime() > now.getTime()) || at.getTime() > now.getTime() + 8 * DAY_MS) throw new ConnectorError({ kind: "provider_error", message: "Microsoft gave a subscription expiry outside the expected range" });
    if (!(await deps.store.renewed(laneId, conn.id, row.subscriptionId, at))) throw new ConnectorError({ kind: "not_found", message: "The subscription is no longer recorded for this connection" });
    return at;
  }

  async function ensure(laneId: LaneId, conn: LaneBoundConnection<string>, input: { now: Date }): Promise<EnsureOutcome> {
    assertLaneBound(laneId, conn);
    if (conn.provider !== "microsoft") throw new ConnectorError({ kind: "forbidden", message: "Connection belongs to another provider" });
    const now = input.now;
    const child = log.child({ laneId, provider: "microsoft", connectionId: conn.id });
    const outcome: EnsureOutcome = { created: 0, renewed: 0, recreated: 0, removed: 0, skipped: null, expiresAt: null };

    let enabled: boolean;
    try {
      const settings = await deps.laneConfig.mailProviderSettings(laneId);
      enabled = providerEnabledIn(settings, "microsoft") && settings.microsoft !== null && isCloudSupported(settings.microsoft.cloud);
    } catch {
      throw new ConnectorError({ kind: "transient", message: "The company's mail settings could not be read" }); // retried by the job, no alert
    }
    if (!enabled) {
      outcome.removed = await deps.store.removeConnection(laneId, conn.id);
      outcome.skipped = "provider_disabled";
      if (outcome.removed > 0) child.info("microsoft.subscription.paused", { count: outcome.removed });
      return outcome;
    }

    let url: string | null;
    try {
      url = deps.notificationUrl();
    } catch (e) {
      // Unreadable or invalid: nothing is attempted, changed or failed. Existing subscriptions are left alone. Only our own fixed text is logged (a variable name and a rule); any other
      // error could carry anything, so it is not.
      outcome.skipped = "config_unreadable";
      child.warn("microsoft.subscription.config_unreadable", isConnectorError(e) ? { detail: e.info.message.slice(0, 200) } : {});
      return outcome;
    }
    if (url === null) {
      outcome.skipped = "not_configured";
      return outcome;
    }

    const rows = await deps.store.list(laneId, conn.id);
    let failure: unknown;
    for (const resource of STREAMS) {
      const row = rows.find((r) => r.resource === resource);
      try {
        if (!row) {
          outcome.expiresAt = minDate(outcome.expiresAt, await create(laneId, conn, resource, url, now));
          outcome.created += 1;
          continue;
        }
        const expired = row.expiresAt.getTime() <= now.getTime();
        const due = row.status === "reauthorization_required" || row.expiresAt.getTime() - now.getTime() <= SUBSCRIPTION_RENEW_WINDOW_MS;
        if (!expired && !due) {
          outcome.expiresAt = minDate(outcome.expiresAt, row.expiresAt);
          continue;
        }
        if (!expired) {
          try {
            outcome.expiresAt = minDate(outcome.expiresAt, await renew(laneId, conn, row, now));
            outcome.renewed += 1;
            continue;
          } catch (e) {
            if (!isGone(e) && !(isConnectorError(e) && e.info.kind === "not_found")) throw e;
          }
        }
        // Expired, or Microsoft no longer has it: the row is removed and a new subscription takes its place.
        await deps.store.mark(laneId, conn.id, row.subscriptionId, "removed");
        outcome.expiresAt = minDate(outcome.expiresAt, await create(laneId, conn, resource, url, now));
        outcome.created += 1;
        outcome.recreated += 1;
      } catch (e) {
        failure ??= e;
        child.warn("microsoft.subscription.failed", { resource, kind: isConnectorError(e) ? e.info.kind : "unknown" });
      }
    }
    if (outcome.created + outcome.renewed > 0) child.info("microsoft.subscription.ensured", { created: outcome.created, renewed: outcome.renewed, recreated: outcome.recreated });
    if (failure !== undefined) throw failure;
    return outcome;
  }

  /** `ensure`, plus the switch-off rule: no configured URL stops what exists. (A separate step so `ensure`'s decision table above stays readable.) */
  return {
    async ensure(laneId, conn, input) {
      const outcome = await ensure(laneId, conn, input);
      if (outcome.skipped === "not_configured") {
        const live = await deps.store.list(laneId, conn.id);
        if (live.length > 0) outcome.removed = await stop(laneId, conn);
      }
      return outcome;
    },
    stop,
    async watchInfo(laneId, conn, resource, now) {
      assertLaneBound(laneId, conn);
      const row = (await deps.store.list(laneId, conn.id)).find((r) => r.resource === resource);
      const created_at = now.toISOString();
      return row
        ? { mode: "push", resource, channel_id: null, resource_id: row.subscriptionId, expires_at: row.expiresAt.toISOString(), created_at }
        : { mode: "polling", resource, channel_id: null, resource_id: null, expires_at: null, created_at };
    },
  };
}

function minDate(a: Date | null, b: Date): Date {
  return a === null || b.getTime() < a.getTime() ? b : a;
}
