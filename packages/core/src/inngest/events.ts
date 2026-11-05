// Typed Inngest events (T-037). Every event carries `laneId` (CLAUDE.md rule 1): each schema below requires it, so
// creating an event without a lane id fails to compile and fails validation; events.test.ts checks every export.
// Payloads are ids only (no content, no tokens): jobs load what they need through the lane router.
// (Declared one by one: Inngest's types cannot check a generic schema-building helper for transforms.)
import { eventType } from "inngest";
import { z } from "zod";

export const laneIdSchema = z.string().regex(/^[A-Z]{1,8}$/);

/** Run a connection's sync (T-038). `trigger` says why (default "manual"); it is logged on the run, nothing else reads it. */
export const connSyncRequested = eventType("conn/sync.requested", {
  schema: z.strictObject({
    laneId: laneIdSchema,
    connectionId: z.uuid(),
    trigger: z.enum(["schedule", "manual", "webhook", "connect"]).optional(),
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

/** Purge one lane's expired rows (T-042). Sent by the daily schedule for each enabled lane, or by hand. Lane id only. */
export const retentionPurgeRequested = eventType("retention/purge.requested", {
  schema: z.strictObject({ laneId: laneIdSchema }),
});

/** Every lane event, for the test that checks they all require laneId. Add new events here. */
export const LANE_EVENTS = [connSyncRequested, actionApproved, systemHeartbeat, webhookReceived, retentionPurgeRequested] as const;
