// Typed Inngest events (T-037). Every event carries `laneId` (CLAUDE.md rule 1): each schema below requires it, so
// creating an event without a lane id fails to compile and fails validation; events.test.ts checks every export.
// Payloads are ids only (no content, no tokens): jobs load what they need through the lane router.
// (Declared one by one: Inngest's types cannot check a generic schema-building helper for transforms.)
import { eventType } from "inngest";
import { z } from "zod";

export const laneIdSchema = z.string().regex(/^[A-Z]{1,8}$/);

/** Run a connection's sync (T-038). */
export const connSyncRequested = eventType("conn/sync.requested", {
  schema: z.strictObject({ laneId: laneIdSchema, connectionId: z.uuid() }),
});

/** An approved action is ready to execute (approvals spec §5, T-193): ids only. */
export const actionApproved = eventType("action/approved", {
  schema: z.strictObject({ laneId: laneIdSchema, actionId: z.uuid() }),
});

/** Smoke test of the job pipeline (local dev server and deployment checks). */
export const systemHeartbeat = eventType("system/heartbeat.requested", {
  schema: z.strictObject({ laneId: laneIdSchema }),
});

/** Every lane event, for the test that checks they all require laneId. Add new events here. */
export const LANE_EVENTS = [connSyncRequested, actionApproved, systemHeartbeat] as const;
