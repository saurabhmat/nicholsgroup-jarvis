import "server-only";
// retention.purge (T-042): two Inngest functions. The purge itself (registry, SQL purge functions, lane-bound DB access)
// is injected as `purgeLane` (apps/web wires @nichols/connectors/retention; core cannot import connectors).
//   - retention-purge-schedule: daily at 03:00 America/New_York (off-hours). Step "plan" saves the list of enabled lanes
//     (a retry replays the saved plan, it does not rescan), step "fan-out" sends one retention/purge.requested per lane.
//   - retention-purge-lane: one lane per run. Concurrency key = lane id, limit 1 (a manual trigger cannot overlap the
//     cron); retries with backoff. A table that fails is reported and the run fails AFTER every other table has been
//     purged, so a retry only repeats idempotent deletes. Lanes are independent runs: one lane failing never blocks another.
// Events carry the lane id only; the lane must be one this deployment serves.
import { NonRetriableError, type Inngest, type InngestFunction } from "inngest";
import { retentionPurgeRequested } from "./events";

/** Mirrors LanePurgeResult in @nichols/connectors/retention (structural: core does not import connectors). */
export type RetentionPurgeResult = {
  laneId: string;
  ok: boolean;
  results: ({ table: string; class: string; deleted: number } | { table: string; class: string; error: string })[];
  emptyClasses: string[];
};

export type RetentionPurgeDeps = {
  purgeLane: (laneId: string) => Promise<RetentionPurgeResult>;
  enabledLanes: () => readonly string[];
};

/** Function options, exported so tests assert them. */
export const RETENTION_CRON = "TZ=America/New_York 0 3 * * *";
export const RETENTION_SCHEDULE_RETRIES = 2;
export const RETENTION_PURGE_RETRIES = 3;
export const RETENTION_PURGE_CONCURRENCY = { key: "event.data.laneId", limit: 1 } as const;

/** The per-lane body without Inngest, for tests. Counts only in the result; a failed table fails the run (retried). */
export async function handleRetentionPurge(
  deps: RetentionPurgeDeps,
  data: { laneId: string },
): Promise<RetentionPurgeResult | { ok: true; skipped: "lane_not_served" }> {
  // Events can reach Inngest without passing sendLaneEvent: validate again, echo nothing.
  const parsed = await retentionPurgeRequested.schema["~standard"].validate(data);
  if (parsed.issues) throw new NonRetriableError("retention.purge: invalid event data");
  if (!deps.enabledLanes().includes(data.laneId)) return { ok: true, skipped: "lane_not_served" };
  const result = await deps.purgeLane(data.laneId);
  if (!result.ok) {
    const failed = result.results.filter((r) => "error" in r).length;
    throw new Error(`retention.purge failed for ${String(failed)} table(s)`);
  }
  return result;
}

export function retentionPurgeFunctions(inngest: Inngest, deps: RetentionPurgeDeps): InngestFunction.Any[] {
  const schedule = inngest.createFunction(
    { id: "retention-purge-schedule", triggers: [{ cron: RETENTION_CRON }], retries: RETENTION_SCHEDULE_RETRIES },
    async ({ step }) => {
      const lanes = await step.run("plan", () => [...deps.enabledLanes()]);
      if (lanes.length === 0) return { lanes: 0 };
      await step.sendEvent(
        "fan-out",
        lanes.map((laneId) => retentionPurgeRequested.create({ laneId })),
      );
      return { lanes: lanes.length };
    },
  );
  const worker = inngest.createFunction(
    {
      id: "retention-purge-lane",
      triggers: [retentionPurgeRequested],
      retries: RETENTION_PURGE_RETRIES,
      concurrency: RETENTION_PURGE_CONCURRENCY,
    },
    async ({ event }) => handleRetentionPurge(deps, event.data),
  );
  return [schedule, worker];
}
