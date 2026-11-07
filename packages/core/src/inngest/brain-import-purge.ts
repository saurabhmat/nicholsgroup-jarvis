import "server-only";
// brain.import_purge (T-210, spec §7a, plan-review finding 19): hourly, deletes brain import candidates older than 23 h
// (so none lives past 24 h) and closes imports still open after 24 h. Not a T-042 day class: retention.purge works in
// whole days, this needs hours. The purge itself (core.brain_import_purge through the lane router's job client) is
// injected as `purgeLane` (apps/web wires @nichols/brain/jobs; core cannot import modules).
//   - Step "plan" saves the enabled lanes; each lane then runs in its own step ("purge-<lane>"), so a retry repeats only
//     the lanes that failed (an idempotent delete anyway). One lane failing never stops the others; the run fails AFTER
//     every lane was tried, with lane ids only in the message (no row data).
//   - Lanes come from enabledLanes() (the deployment's served lanes) and the SQL function refuses disabled lanes again.
import { NonRetriableError, type Inngest, type InngestFunction } from "inngest";

export type BrainImportPurgeDeps = {
  purgeLane: (laneId: string) => Promise<number>;
  enabledLanes: () => readonly string[];
};

/** Function options, exported so tests assert them. */
export const BRAIN_IMPORT_PURGE_CRON = "7 * * * *"; // hourly, off the top of the hour
export const BRAIN_IMPORT_PURGE_RETRIES = 2;

const LANE = /^[A-Z]{1,8}$/;

type StepApi = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

/** The function body without Inngest, for tests. */
export async function handleBrainImportPurge(deps: BrainImportPurgeDeps, step: StepApi) {
  const lanes = await step.run("plan", () => [...new Set(deps.enabledLanes())].filter((l) => LANE.test(l)));
  const deleted: Record<string, number> = {};
  const failed: string[] = [];
  for (const laneId of lanes) {
    try {
      deleted[laneId] = await step.run(`purge-${laneId}`, () => deps.purgeLane(laneId));
    } catch {
      failed.push(laneId);
    }
  }
  if (failed.length > 0) throw new NonRetriableError(`brain.import_purge: failed for lane(s) ${failed.join(",")}`);
  return { lanes: lanes.length, deleted };
}

export function brainImportPurgeFunction(inngest: Inngest, deps: BrainImportPurgeDeps): InngestFunction.Any {
  return inngest.createFunction(
    { id: "brain-import-purge", triggers: [{ cron: BRAIN_IMPORT_PURGE_CRON }], retries: BRAIN_IMPORT_PURGE_RETRIES },
    async ({ step }) => handleBrainImportPurge(deps, step as unknown as StepApi),
  );
}
