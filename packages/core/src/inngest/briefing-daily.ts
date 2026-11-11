import "server-only";
// briefing.daily (T-231c, refines T-162): an hourly tick at :05. For each served lane the injected `dueOwners` decides,
// from lane_config.briefing (schedule_enabled, default FALSE; time, America/New_York), whether the lane is due this hour
// and which owners still hold the briefing view; each (lane, owner) then runs in its own step with an idempotency id of
// lane + owner + New York date, so a retried tick never prepares the same day's briefing twice. One run failing never
// stops the others; the tick fails after all were tried, with lane ids only. core cannot import modules: apps/web injects
// the run (lib/briefing-run with the job client).
import { NonRetriableError, type Inngest, type InngestFunction } from "inngest";

export type BriefingDailyDeps = {
  enabledLanes: () => readonly string[];
  /** Owners whose briefing is due now in this lane ([] when the schedule is off or not this hour). */
  dueOwners: (laneId: string, now: Date) => Promise<string[]>;
  run: (laneId: string, ownerUserId: string, now: Date) => Promise<string>;
};

export const BRIEFING_DAILY_CRON = "5 * * * *";
export const BRIEFING_DAILY_RETRIES = 1;

const LANE = /^[A-Z]{1,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type StepApi = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

const nyDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** The function body without Inngest, for tests. */
export async function handleBriefingDaily(deps: BriefingDailyDeps, step: StepApi, now: Date) {
  const lanes = await step.run("plan", () => [...new Set(deps.enabledLanes())].filter((l) => LANE.test(l)));
  const prepared: string[] = [];
  const failed: string[] = [];
  for (const laneId of lanes) {
    let owners: string[] = [];
    try {
      owners = (await step.run(`due-${laneId}`, () => deps.dueOwners(laneId, now))).filter((o) => UUID.test(o));
    } catch {
      failed.push(laneId);
      continue;
    }
    for (const owner of owners) {
      try {
        prepared.push(await step.run(`brief-${laneId}-${owner}-${nyDate(now)}`, () => deps.run(laneId, owner, now)));
      } catch {
        failed.push(laneId);
      }
    }
  }
  if (failed.length > 0) throw new NonRetriableError(`briefing.daily: failed for lane(s) ${[...new Set(failed)].join(",")}`);
  return { lanes: lanes.length, prepared: prepared.length };
}

/** Whether `now` is the lane's briefing hour (New York wall clock, hh of "hh:mm"). */
export function isBriefingHour(time: string, now: Date): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(now));
  return Number(time.slice(0, 2)) === hour;
}

export function briefingDailyFunction(inngest: Inngest, deps: BriefingDailyDeps): InngestFunction.Any {
  return inngest.createFunction(
    { id: "briefing-daily", triggers: [{ cron: BRIEFING_DAILY_CRON }], retries: BRIEFING_DAILY_RETRIES },
    async ({ step }) => handleBriefingDaily(deps, step as unknown as StepApi, new Date()),
  );
}
