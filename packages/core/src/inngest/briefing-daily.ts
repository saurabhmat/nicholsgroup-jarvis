import "server-only";
// briefing.daily (T-231c, refines T-162): a tick every 15 minutes. For each served lane the injected `dueOwners` decides,
// from lane_config.briefing (schedule_enabled, default FALSE; time + days, America/New_York, D-32 06:30 Mon-Fri), whether
// the lane is due in this tick's 15-minute window
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

export const BRIEFING_DAILY_CRON = "*/15 * * * *";
/** Width of one tick's window (matches the cron): a time is due in the tick at or before it, never twice a day. */
export const BRIEFING_WINDOW_MINUTES = 15;
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

const NY_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" });
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Whether `now` falls in the 15-minute window that starts at the lane's briefing time ("hh:mm", New York wall clock) on
 * one of `days` (0 = Sunday, New York date). Ticks run at :00/:15/:30/:45, so "06:30" runs at 06:30 and "06:40" at 06:45.
 * On the DST fall-back day a 01:xx time can match twice (the hour repeats); the default 06:30 cannot.
 */
export function isBriefingDue(time: string, days: readonly number[], now: Date): boolean {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) return false;
  const parts = Object.fromEntries(NY_PARTS.formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = WEEKDAY[parts.weekday ?? ""];
  if (weekday === undefined || !days.includes(weekday)) return false;
  const nowMin = Number(parts.hour) * 60 + Number(parts.minute);
  const target = Number(m[1]) * 60 + Number(m[2]);
  // The window (now - 15 min, now] contains the target: the first tick at or after the target.
  return target <= nowMin && nowMin - target < BRIEFING_WINDOW_MINUTES;
}

export function briefingDailyFunction(inngest: Inngest, deps: BriefingDailyDeps): InngestFunction.Any {
  return inngest.createFunction(
    { id: "briefing-daily", triggers: [{ cron: BRIEFING_DAILY_CRON }], retries: BRIEFING_DAILY_RETRIES },
    async ({ step }) => handleBriefingDaily(deps, step as unknown as StepApi, new Date()),
  );
}
