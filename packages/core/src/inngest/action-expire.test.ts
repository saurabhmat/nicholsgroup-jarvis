import { Inngest } from "inngest";
import { describe, expect, it } from "vitest";
import { ACTION_EXPIRE_CRON, actionExpireFunction, handleActionExpire } from "./action-expire";

const step = { run: async <T,>(_id: string, fn: () => T | Promise<T>) => fn() };

describe("action.expire", () => {
  it("is a 15-minute cron function", () => {
    const fn = actionExpireFunction(new Inngest({ id: "test-app", isDev: true }), { enabledLanes: () => [], expireLane: async () => 0 }) as unknown as { opts: Record<string, unknown> };
    expect(fn.opts.id).toBe("action-expire");
    expect(ACTION_EXPIRE_CRON).toBe("*/15 * * * *");
  });
  it("expires every served lane, keeps going after a failure, then fails with lane ids only", async () => {
    const done: string[] = [];
    const deps = {
      enabledLanes: () => ["PKG", "APK", "PKG", "bad lane"],
      expireLane: async (l: string) => {
        if (l === "APK") throw new Error("db down: secret detail");
        done.push(l);
        return 2;
      },
    };
    const err = await handleActionExpire(deps, step).catch((e: Error) => e);
    expect(String(err)).toContain("action.expire: failed for lane(s) APK");
    expect(String(err)).not.toContain("secret detail");
    expect(done).toEqual(["PKG"]);
  });
  it("reports counts per lane", async () => {
    await expect(handleActionExpire({ enabledLanes: () => ["PKG"], expireLane: async () => 3 }, step)).resolves.toEqual({ lanes: 1, expired: { PKG: 3 } });
  });
});
