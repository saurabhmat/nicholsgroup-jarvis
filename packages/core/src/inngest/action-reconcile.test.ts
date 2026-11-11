import { Inngest } from "inngest";
import { describe, expect, it } from "vitest";
import { ACTION_RECONCILE_CRON, actionReconcileFunction, handleActionReconcile } from "./action-reconcile";

const step = { run: async <T,>(_id: string, fn: () => T | Promise<T>) => fn() };
const sum = { checked: 1, verified: 1, failed: 0, undecided: 0, unchanged: 0, errors: 0 };

describe("action.reconcile_stuck", () => {
  it("is a 5-minute cron function, one run at a time", () => {
    const fn = actionReconcileFunction(new Inngest({ id: "test-app", isDev: true }), { enabledLanes: () => [], reconcileLane: async () => sum }) as unknown as { opts: Record<string, unknown> };
    expect(fn.opts.id).toBe("action-reconcile-stuck");
    expect(fn.opts.concurrency).toBe(1);
    expect(ACTION_RECONCILE_CRON).toBe("*/5 * * * *");
  });
  it("sweeps every served lane, keeps going after a failure, then fails with lane ids only", async () => {
    const done: string[] = [];
    const deps = {
      enabledLanes: () => ["PKG", "APK", "PKG", "bad lane"],
      reconcileLane: async (l: string) => {
        if (l === "APK") throw new Error("db down: secret detail");
        done.push(l);
        return sum;
      },
    };
    const err = await handleActionReconcile(deps, step).catch((e: Error) => e);
    expect(String(err)).toContain("action.reconcile_stuck: failed for lane(s) APK");
    expect(String(err)).not.toContain("secret detail");
    expect(done).toEqual(["PKG"]);
  });
  it("fails the run (ids only) when a sweep reported per-action errors, after sweeping every lane", async () => {
    const done: string[] = [];
    const deps = {
      enabledLanes: () => ["PKG", "APK"],
      reconcileLane: async (l: string) => {
        done.push(l);
        return { ...sum, errors: l === "PKG" ? 2 : 0 };
      },
    };
    const err = await handleActionReconcile(deps, step).catch((e: Error) => e);
    expect(String(err)).toContain("action.reconcile_stuck: errors in lane(s) PKG");
    expect(done).toEqual(["PKG", "APK"]);
  });
  it("reports per lane", async () => {
    await expect(handleActionReconcile({ enabledLanes: () => ["PKG"], reconcileLane: async () => sum }, step)).resolves.toEqual({ lanes: 1, results: { PKG: sum } });
  });
});
