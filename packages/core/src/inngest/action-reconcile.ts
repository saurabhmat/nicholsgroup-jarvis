import "server-only";
// action.reconcile_stuck (T-192, spec approvals §6): every 5 minutes, per served lane, actions left `executing` longer than
// the lane's `approvals.reconcile_after_minutes` (default 10) are verified through the provider's marker lookup and
// read-back, or failed with `outcome_unknown` for a human. Verify-only: never a second claim, never a send (the module's
// sweep holds no write path). Same shape as action.expire: the sweep is injected (apps/web wires @nichols/approvals/wire;
// core cannot import modules); one step per lane; one lane failing never stops the others; lane ids only in the error.
// Inngest runs one at a time (concurrency 1); the database transition is conditional anyway, so an overlap is harmless.
import { NonRetriableError, type Inngest, type InngestFunction } from "inngest";

export type ActionReconcileSummary = { checked: number; verified: number; failed: number; undecided: number; unchanged: number; errors: number };
export type ActionReconcileDeps = {
  reconcileLane: (laneId: string) => Promise<ActionReconcileSummary>;
  enabledLanes: () => readonly string[];
};

export const ACTION_RECONCILE_CRON = "*/5 * * * *";
export const ACTION_RECONCILE_RETRIES = 1;

const LANE = /^[A-Z]{1,8}$/;
type StepApi = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

export async function handleActionReconcile(deps: ActionReconcileDeps, step: StepApi) {
  const lanes = await step.run("plan", () => [...new Set(deps.enabledLanes())].filter((l) => LANE.test(l)));
  const results: Record<string, ActionReconcileSummary> = {};
  const failed: string[] = [];
  for (const laneId of lanes) {
    try {
      results[laneId] = await step.run(`reconcile-${laneId}`, () => deps.reconcileLane(laneId));
    } catch {
      failed.push(laneId);
    }
  }
  if (failed.length > 0) throw new NonRetriableError(`action.reconcile_stuck: failed for lane(s) ${failed.join(",")}`);
  // Per-action errors are logged inside the sweep; surfacing them here makes the run show as failed (ids only, no detail).
  const erroring = Object.entries(results).filter(([, r]) => r.errors > 0).map(([l]) => l);
  if (erroring.length > 0) throw new NonRetriableError(`action.reconcile_stuck: errors in lane(s) ${erroring.join(",")}`);
  return { lanes: lanes.length, results };
}

export function actionReconcileFunction(inngest: Inngest, deps: ActionReconcileDeps): InngestFunction.Any {
  return inngest.createFunction(
    { id: "action-reconcile-stuck", triggers: [{ cron: ACTION_RECONCILE_CRON }], retries: ACTION_RECONCILE_RETRIES, concurrency: 1 },
    async ({ step }) => handleActionReconcile(deps, step as unknown as StepApi),
  );
}
