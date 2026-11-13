// Typed Inngest events (T-037). Every event carries `laneId` (CLAUDE.md rule 1): each schema below requires it, so
// creating an event without a lane id fails to compile and fails validation; events.test.ts checks every export.
// Payloads are ids only (no content, no tokens): jobs load what they need through the lane router.
// (Declared one by one: Inngest's types cannot check a generic schema-building helper for transforms.)
import { eventType } from "inngest";
import { z } from "zod";

export const laneIdSchema = z.string().regex(/^[A-Z]{1,8}$/);

/** Run a connection's sync (T-038). `trigger` says why and is required (T-130): it is logged on the run, nothing else reads it. */
export const connSyncRequested = eventType("conn/sync.requested", {
  schema: z.strictObject({
    laneId: laneIdSchema,
    connectionId: z.uuid(),
    trigger: z.enum(["schedule", "manual", "webhook", "connect"]),
    /**
     * Limit the run to these object types (a targeted fetch after a webhook, T-053). Names only, never ids or content; the
     * connector checks them against its own allowlist again and refuses an unknown one. Absent = the whole connection.
     */
    objectTypes: z.array(z.string().regex(/^[A-Za-z]{1,40}$/)).min(1).max(16).optional(),
  }),
});

/** An approved action is ready to execute (approvals spec §5, T-193): ids only. */
export const actionApproved = eventType("action/approved", {
  schema: z.strictObject({ laneId: laneIdSchema, actionId: z.uuid() }),
});

/** Smoke test of the job pipeline (local dev server and deployment checks). */
export const systemHeartbeat = eventType("system/heartbeat.requested", {
  schema: z.strictObject({ laneId: laneIdSchema }),
});

/**
 * A verified provider webhook was accepted (T-036). Ids only, never the payload: the handler fetches the objects through
 * the connector (raw records, T-039). `connectionId` is resolved server-side from the provider account (D-23), never
 * taken from the payload. `refs` names the changed objects (type + id), at most 100. Handlers filter on `provider`.
 */
export const webhookReceived = eventType("webhook/received", {
  schema: z.strictObject({
    laneId: laneIdSchema,
    provider: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    connectionId: z.uuid(),
    eventId: z.string().min(1).max(256),
    eventType: z.string().min(1).max(128),
    refs: z.array(z.strictObject({ type: z.string().min(1).max(64), id: z.string().min(1).max(256) })).max(100),
  }),
});

/** Check one connection's token expiry and health (T-040). Sent by the daily scan, one per connection. */
export const connHealthCheckRequested = eventType("conn/health.check.requested", {
  schema: z.strictObject({ laneId: laneIdSchema, connectionId: z.uuid() }),
});

/** Renew one connection's push subscription if it is due (T-040). Sent by the renewal scan, one per connection. */
export const connSubscriptionRenewRequested = eventType("conn/subscription.renew.requested", {
  schema: z.strictObject({ laneId: laneIdSchema, connectionId: z.uuid() }),
});

export const CONN_ATTENTION_REASONS = ["token_expiring", "token_expired", "health_check_failed", "subscription_renewal_failed", "reconnect_required"] as const;

/**
 * A connection needs a person's attention (T-040): its credential expires within 7 days, a health check failed, a
 * subscription could not be renewed, or (T-195) the provider refused the refresh token / grant (`reconnect_required`: the
 * connection is already recorded as reconnect_required and its sync has stopped; an admin must reconnect it). Notification event; no consumer exists yet (the notification module that sends it
 * to the admin is not built; the backlog's "T-181" reference is stale, see plan-review Nov 5 T-040). Ids and enums
 * only: never an error message, token or provider text. `errorKind` is a ConnectorErrorKind; `daysLeft` is whole days
 * until the credential expires (negative once expired).
 */
export const connAttentionNeeded = eventType("conn/attention.needed", {
  schema: z.strictObject({
    laneId: laneIdSchema,
    connectionId: z.uuid(),
    provider: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    reason: z.enum(CONN_ATTENTION_REASONS),
    errorKind: z.string().regex(/^[a-z_]{1,32}$/).optional(),
    daysLeft: z.number().int().min(-3650).max(3650).optional(),
  }),
});

/** The Inngest event id of an attention alert: one per connection, reason and UTC day, so a repeat the same day is dropped. Shared by every sender (conn-health, the QuickBooks reconnect recorder). */
export const attentionEventId = (laneId: string, connectionId: string, reason: (typeof CONN_ATTENTION_REASONS)[number], now: Date): string =>
  `attn:${laneId}:${connectionId}:${reason}:${now.toISOString().slice(0, 10)}`;

/** Purge one lane's expired rows (T-042). Sent by the daily schedule for each enabled lane, or by hand. Lane id only. */
export const retentionPurgeRequested = eventType("retention/purge.requested", {
  schema: z.strictObject({ laneId: laneIdSchema }),
});

/** Pull a QuickBooks connection's summary reports into fin.report_cache (T-052). Ids only; `trigger` is logged, nothing else reads it. */
export const finQboReportsRequested = eventType("fin/qbo-reports.requested", {
  schema: z.strictObject({
    laneId: laneIdSchema,
    connectionId: z.uuid(),
    trigger: z.enum(["schedule", "manual", "weekly_cash"]),
  }),
});

/**
 * Normalize a QuickBooks connection's synced raw records into fin.* (T-056). Sent by the route after a successful
 * QuickBooks conn.sync (`trigger: "sync"`), or by hand. Ids only; `trigger` is logged, nothing else reads it.
 */
export const finQboNormalizeRequested = eventType("fin/qbo-normalize.requested", {
  schema: z.strictObject({
    laneId: laneIdSchema,
    connectionId: z.uuid(),
    trigger: z.enum(["sync", "manual", "schedule"]),
  }),
});

/** Every lane event, for the test that checks they all require laneId. Add new events here. */
export const LANE_EVENTS = [
  connSyncRequested,
  actionApproved,
  systemHeartbeat,
  webhookReceived,
  connHealthCheckRequested,
  connSubscriptionRenewRequested,
  connAttentionNeeded,
  retentionPurgeRequested,
  finQboReportsRequested,
  finQboNormalizeRequested,
] as const;
