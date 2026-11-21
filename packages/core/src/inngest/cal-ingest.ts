import "server-only";
// cal.ingest_delta (T-130): the schedule that keeps cal.event_index fresh. The delta sync itself is T-064's calendar sync
// (syncToken per calendar, 410 full resync), run by conn.sync (T-038) for Google connections. This function only decides
// WHEN: every 15 minutes it lists each enabled lane's usable calendar-capable connections and asks conn.sync to run them.
//   - Cadence 15 minutes: calendar changes (moved meetings) matter within the quarter hour for an executive's day view,
//     one delta call per calendar costs a single cheap request when nothing changed, and Google Calendar quotas are far
//     above 4 requests an hour per calendar. (Calendar push is not built; this polling is the freshness mechanism.)
//   - Streams (T-238): the event asks for ["calendar"] only. The Gmail delta has its own schedule (mail-ingest-delta,
//     mail-ingest.ts), so each stream runs once per tick and never twice. Manual, connect and webhook syncs omit `streams`
//     and keep running both.
//   - Fan-out: step "plan" lists every lane (a lane that cannot be listed is recorded and skipped, never blocking the
//     others); step "fan-out" sends conn/sync.requested with trigger "schedule" and the deterministic event id
//     `cal-ingest:<connectionId>:<slot>`, so Inngest drops a duplicate of the same tick (a retry, a double cron).
//   - conn.sync has concurrency 1 per connection, so ticks never overlap; a sync that overruns its slot queues one more run.
//   - The fan-out uses step.sendEvent, not sendLaneEvent: lanes come only from enabledLanes() above and conn.sync validates
//     the event and the lane again on receipt. Keep the enabledLanes() filter if this changes.
// Events carry ids only; the lane must be one this deployment serves.
import { NonRetriableError, type Inngest, type InngestFunction } from "inngest";
import { connSyncRequested } from "./events";

export type CalIngestDeps = {
  /** Usable calendar-capable connection ids of the lane (apps/web wires @nichols/connectors/sync; core cannot import connectors). */
  listConnections: (laneId: string) => Promise<readonly string[]>;
  enabledLanes: () => readonly string[];
};

/** Function options, exported so tests assert them. */
export const CAL_INGEST_CADENCE_MINUTES = 15;
export const CAL_INGEST_CADENCE_MS = CAL_INGEST_CADENCE_MINUTES * 60_000;
export const CAL_INGEST_CRON = `*/${String(CAL_INGEST_CADENCE_MINUTES)} * * * *`;
export const CAL_INGEST_RETRIES = 2;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The tick a scheduled time belongs to; the same tick always gives the same number. */
export function calIngestSlot(timeMs: number): number {
  if (!Number.isFinite(timeMs) || timeMs < 0) throw new NonRetriableError("cal.ingest_delta: invalid schedule time");
  return Math.floor(timeMs / CAL_INGEST_CADENCE_MS);
}

/** Deterministic Inngest event id for one connection in one tick. */
export function calIngestEventId(connectionId: string, slot: number): string {
  return `cal-ingest:${connectionId}:${String(slot)}`;
}

export type CalIngestPlan = { sends: { laneId: string; connectionId: string }[]; failedLanes: string[] };

/** Lists every enabled lane; one lane failing is recorded (lane id only: no error text) and does not stop the rest. */
export async function planCalIngest(deps: CalIngestDeps): Promise<CalIngestPlan> {
  const sends: CalIngestPlan["sends"] = [];
  const failedLanes: string[] = [];
  for (const laneId of new Set(deps.enabledLanes())) {
    try {
      const ids = await deps.listConnections(laneId);
      for (const connectionId of new Set(ids)) {
        if (UUID.test(connectionId)) sends.push({ laneId, connectionId });
      }
    } catch {
      failedLanes.push(laneId);
    }
  }
  return { sends, failedLanes };
}

type StepApi = {
  run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T>;
  sendEvent: (id: string, events: ReturnType<typeof connSyncRequested.create>[]) => Promise<unknown>;
};

/** The function body without Inngest, for tests. `scheduledAtMs` is the cron event time (stable across retries). */
export async function handleCalIngest(deps: CalIngestDeps, scheduledAtMs: unknown, step: StepApi) {
  if (typeof scheduledAtMs !== "number") throw new NonRetriableError("cal.ingest_delta: invalid schedule time");
  const slot = calIngestSlot(scheduledAtMs);
  const plan: CalIngestPlan = await step.run("plan", () => planCalIngest(deps));
  if (plan.sends.length > 0) {
    await step.sendEvent(
      "fan-out",
      plan.sends.map((s) => connSyncRequested.create({ laneId: s.laneId, connectionId: s.connectionId, trigger: "schedule", streams: ["calendar"] }, { id: calIngestEventId(s.connectionId, slot) })),
    );
  }
  // Fail the run (visible in Inngest) AFTER the healthy lanes were sent. Not retried: a retry replays the saved plan; the next tick is the retry.
  if (plan.failedLanes.length > 0) throw new NonRetriableError(`cal.ingest_delta: ${String(plan.failedLanes.length)} lane(s) could not be listed`);
  return { lanes: new Set(plan.sends.map((s) => s.laneId)).size, connections: plan.sends.length, slot };
}

export function calIngestFunction(inngest: Inngest, deps: CalIngestDeps): InngestFunction.Any {
  return inngest.createFunction(
    { id: "cal-ingest-delta", triggers: [{ cron: CAL_INGEST_CRON }], retries: CAL_INGEST_RETRIES },
    async ({ event, step }) => handleCalIngest(deps, event.ts, step as unknown as StepApi),
  );
}
