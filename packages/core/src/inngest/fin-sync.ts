import "server-only";
// fin.sync, QuickBooks (T-090): the BACKUP CDC poll. Webhooks (T-053) are the fast path; this schedule catches a webhook
// that never arrived. The sync itself is conn.sync (T-038) running T-051's CDC; this function only decides WHEN.
//   - The cron fires every hour (UTC); a lane is polled when the hour index is a multiple of its
//     `lane_config.finance.qbo_sync.interval_hours` (1, 2, 3, 4, 6, 8 or 12; default 4, so 00/04/08/12/16/20 UTC). A cron
//     cannot differ per lane, so the lane's cadence is applied here. A setting that cannot be read or is not one of the
//     allowed values fails that lane for the tick (recorded by lane id only) and never blocks the others.
//   - Step "plan" lists every enabled lane's usable QuickBooks connections (reconnect_required, disconnected and pending
//     ones are not listed; conn.sync checks the status again and skips). Step "fan-out" sends conn/sync.requested with
//     trigger "schedule" and the deterministic id `fin-sync:<connectionId>:<hour index>`, so Inngest drops a duplicate of
//     the same tick (a retry, a double cron). conn.sync logs the core.sync_runs row, runs one connection at a time
//     (concurrency 1) and starts the normalizer after it (T-056).
//   - Once a day (00:00 UTC) it also asks the normalizer (T-056) to run for the same connections, the catch-up that lets
//     conn.sync skip normalizing after a scheduled poll that wrote nothing (shouldNormalizeAfterSync).
//   - Stripe and GoHighLevel schedules (T-058, T-060) copy this pattern with their own provider list.
//   - The fan-out uses step.sendEvent, not sendLaneEvent: lanes come only from enabledLanes() and conn.sync validates the
//     event and the lane again on receipt. Keep the enabledLanes() filter if this changes.
// Events carry ids only; the lane must be one this deployment serves.
import { NonRetriableError, type Inngest, type InngestFunction } from "inngest";
import { QBO_SYNC_INTERVAL_HOURS } from "../lane-config";
import { connSyncRequested, finQboNormalizeRequested } from "./events";
import { finNormalizeEventId } from "./fin-normalize";

export type FinSyncDeps = {
  /** Usable QuickBooks connection ids of the lane (apps/web wires @nichols/connectors/sync; core cannot import connectors). */
  listConnections: (laneId: string) => Promise<readonly string[]>;
  /** Hours between polls for the lane, from lane_config (default 4); throws when the setting is malformed. */
  intervalHours: (laneId: string) => Promise<number>;
  enabledLanes: () => readonly string[];
};

/** Function options, exported so tests assert them. */
export const FIN_SYNC_CRON = "0 * * * *";
export const FIN_SYNC_RETRIES = 2;
/** The allowed intervals (all divide 24, so 00:00 UTC is a poll hour for every lane). */
export const FIN_SYNC_INTERVALS = QBO_SYNC_INTERVAL_HOURS;
const HOUR_MS = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The hour a scheduled time belongs to; the same hour always gives the same number. */
export function finSyncHour(timeMs: number): number {
  if (!Number.isFinite(timeMs) || timeMs < 0) throw new NonRetriableError("fin.sync: invalid schedule time");
  return Math.floor(timeMs / HOUR_MS);
}

/** Whether a lane with this interval is polled in this hour. */
export function finSyncDue(hour: number, intervalHours: unknown): boolean {
  if (typeof intervalHours !== "number" || !(FIN_SYNC_INTERVALS as readonly number[]).includes(intervalHours)) {
    throw new Error("fin.sync: invalid interval");
  }
  return hour % intervalHours === 0;
}

/** Deterministic Inngest event id for one connection in one hour. */
export function finSyncEventId(connectionId: string, hour: number): string {
  if (!UUID.test(connectionId) || !Number.isSafeInteger(hour) || hour < 0) throw new Error("fin.sync: invalid event id parts");
  return `fin-sync:${connectionId}:${String(hour)}`;
}

export type FinSyncPlan = { sends: { laneId: string; connectionId: string }[]; failedLanes: string[] };

/** Lists every enabled lane that is due; one lane failing is recorded (lane id only: no error text) and does not stop the rest. */
export async function planFinSync(deps: FinSyncDeps, hour: number): Promise<FinSyncPlan> {
  const sends: FinSyncPlan["sends"] = [];
  const failedLanes: string[] = [];
  for (const laneId of new Set(deps.enabledLanes())) {
    try {
      if (!finSyncDue(hour, await deps.intervalHours(laneId))) continue;
      for (const connectionId of new Set(await deps.listConnections(laneId))) {
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
  sendEvent: (id: string, events: (ReturnType<typeof connSyncRequested.create> | ReturnType<typeof finQboNormalizeRequested.create>)[]) => Promise<unknown>;
};

/** The function body without Inngest, for tests. `scheduledAtMs` is the cron event time (stable across retries). */
export async function handleFinSync(deps: FinSyncDeps, scheduledAtMs: unknown, step: StepApi) {
  if (typeof scheduledAtMs !== "number") throw new NonRetriableError("fin.sync: invalid schedule time");
  const hour = finSyncHour(scheduledAtMs);
  const plan: FinSyncPlan = await step.run("plan", () => planFinSync(deps, hour));
  if (plan.sends.length > 0) {
    await step.sendEvent(
      "fan-out",
      plan.sends.map((s) => connSyncRequested.create({ laneId: s.laneId, connectionId: s.connectionId, trigger: "schedule" }, { id: finSyncEventId(s.connectionId, hour) })),
    );
  }
  // Daily catch-up (00:00 UTC, a poll hour for every lane): re-normalize each connection even if the polls wrote nothing, so a
  // mapping change or a failed normalize follow-up is repaired within a day (the per-sync normalize skips empty scheduled polls,
  // shouldNormalizeAfterSync). Idempotent; the id is per connection and day.
  if (plan.sends.length > 0 && hour % 24 === 0) {
    await step.sendEvent(
      "fan-out-normalize",
      plan.sends.map((s) => finQboNormalizeRequested.create({ laneId: s.laneId, connectionId: s.connectionId, trigger: "schedule" }, { id: finNormalizeEventId(s.connectionId, `daily-${String(hour / 24)}`) })),
    );
  }
  // Fail the run (visible in Inngest) AFTER the healthy lanes were sent. Not retried: a retry replays the saved plan; the next tick is the retry.
  if (plan.failedLanes.length > 0) throw new NonRetriableError(`fin.sync: ${String(plan.failedLanes.length)} lane(s) could not be planned`);
  return { lanes: new Set(plan.sends.map((s) => s.laneId)).size, connections: plan.sends.length, hour };
}

export function finSyncFunction(inngest: Inngest, deps: FinSyncDeps): InngestFunction.Any {
  return inngest.createFunction(
    { id: "fin-sync-quickbooks", triggers: [{ cron: FIN_SYNC_CRON }], retries: FIN_SYNC_RETRIES },
    async ({ event, step }) => handleFinSync(deps, event.ts, step as unknown as StepApi),
  );
}
