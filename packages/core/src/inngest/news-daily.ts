import "server-only";
// news.daily (T-234 part 4): a tick every 15 minutes. For each served lane the injected `due` says whether GovCon news is
// configured (lane_config.news.enabled) and the lane's fetch time (news.time, America/New_York, default 06:00) has passed
// today; then `run` fetches. The database is the authority: core.news_begin_scheduled refuses a lane without the `web` policy
// category, a fetch once the New York date already has an ok/partial digest, a retry sooner than 30 minutes after the last
// attempt, a 4th attempt after 3 failures, a fetch over the monthly cap and a fetch while another is in flight. A failed or lost
// morning attempt is therefore retried by a later 15-minute tick; a retried or doubled tick can never fetch twice or overspend. A refusal is a normal "skipped" outcome. One lane
// failing never stops the others; the tick fails after all were tried, with lane ids only. core cannot import modules:
// apps/web injects the run (lib/news-schedule with the job client).
import { NonRetriableError, type Inngest, type InngestFunction } from "inngest";

export type NewsDailyDeps = {
  enabledLanes: () => readonly string[];
  /** Whether this lane should try a fetch at `now` (config on and its time reached). Cheap: no model call. */
  due: (laneId: string, now: Date) => Promise<boolean>;
  /** One fetch for one lane: "fetched", "failed" (stored with its code) or "skipped:<reason>". Throws only for infrastructure faults. */
  run: (laneId: string, now: Date) => Promise<string>;
};

export const NEWS_DAILY_CRON = "*/15 * * * *";
export const NEWS_DAILY_RETRIES = 1;

const LANE = /^[A-Z]{1,8}$/;
type StepApi = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

const nyDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const NY_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" });

/** True once the New York wall clock is at or past "hh:mm" (a malformed time is never reached). Resets at New York midnight. */
export function isNewsTimeReached(time: string, now: Date): boolean {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) return false;
  const parts = Object.fromEntries(NY_CLOCK.formatToParts(now).map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute) >= Number(m[1]) * 60 + Number(m[2]);
}

/** The function body without Inngest, for tests. */
export async function handleNewsDaily(deps: NewsDailyDeps, step: StepApi, now: Date) {
  const lanes = await step.run("plan", () => [...new Set(deps.enabledLanes())].filter((l) => LANE.test(l)));
  const outcomes: Record<string, string> = {};
  const failed: string[] = [];
  for (const laneId of lanes) {
    try {
      if (!(await step.run(`due-${laneId}`, () => deps.due(laneId, now)))) {
        outcomes[laneId] = "skipped:not_due";
        continue;
      }
      outcomes[laneId] = await step.run(`news-${laneId}-${nyDate(now)}`, () => deps.run(laneId, now));
    } catch {
      failed.push(laneId);
    }
  }
  if (failed.length > 0) throw new NonRetriableError(`news.daily: failed for lane(s) ${[...new Set(failed)].join(",")}`);
  return { lanes: lanes.length, outcomes };
}

export function newsDailyFunction(inngest: Inngest, deps: NewsDailyDeps): InngestFunction.Any {
  return inngest.createFunction({ id: "news-daily", triggers: [{ cron: NEWS_DAILY_CRON }], retries: NEWS_DAILY_RETRIES }, async ({ step }) =>
    handleNewsDaily(deps, step as unknown as StepApi, new Date()),
  );
}
