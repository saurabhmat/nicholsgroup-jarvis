import "server-only";
// action.expire (T-232 security review M2, spec approvals §4 / D-19): every 15 minutes, per served lane, pending or
// approved-but-unexecuted actions past `expires_at` become `expired` (core.act_expire_stale), which removes the composed
// body in the same statement. Without it a proposal nobody opens would keep its body indefinitely. Same shape as
// brain.import_purge: the expiry is injected (apps/web wires @nichols/approvals/wire; core cannot import modules); one
// step per lane; one lane failing never stops the others; lane ids only in the error.
import { NonRetriableError, type Inngest, type InngestFunction } from "inngest";

export type ActionExpireDeps = {
  expireLane: (laneId: string) => Promise<number>;
  enabledLanes: () => readonly string[];
};

export const ACTION_EXPIRE_CRON = "*/15 * * * *";
export const ACTION_EXPIRE_RETRIES = 2;

const LANE = /^[A-Z]{1,8}$/;
type StepApi = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

export async function handleActionExpire(deps: ActionExpireDeps, step: StepApi) {
  const lanes = await step.run("plan", () => [...new Set(deps.enabledLanes())].filter((l) => LANE.test(l)));
  const expired: Record<string, number> = {};
  const failed: string[] = [];
  for (const laneId of lanes) {
    try {
      expired[laneId] = await step.run(`expire-${laneId}`, () => deps.expireLane(laneId));
    } catch {
      failed.push(laneId);
    }
  }
  if (failed.length > 0) throw new NonRetriableError(`action.expire: failed for lane(s) ${failed.join(",")}`);
  return { lanes: lanes.length, expired };
}

export function actionExpireFunction(inngest: Inngest, deps: ActionExpireDeps): InngestFunction.Any {
  return inngest.createFunction(
    { id: "action-expire", triggers: [{ cron: ACTION_EXPIRE_CRON }], retries: ACTION_EXPIRE_RETRIES },
    async ({ step }) => handleActionExpire(deps, step as unknown as StepApi),
  );
}
