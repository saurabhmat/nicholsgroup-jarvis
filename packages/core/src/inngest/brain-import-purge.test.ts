// brain.import_purge (T-210): hourly cron, one step per enabled lane, a failing lane never stops the others.
import { Inngest, NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import {
  BRAIN_IMPORT_PURGE_CRON,
  BRAIN_IMPORT_PURGE_RETRIES,
  brainImportPurgeFunction,
  handleBrainImportPurge,
  type BrainImportPurgeDeps,
} from "./brain-import-purge";

const step = () => {
  const ids: string[] = [];
  return { ids, api: { run: async <T>(id: string, fn: () => T | Promise<T>) => (ids.push(id), fn()) } };
};

describe("config", () => {
  it("runs hourly with retries as brain-import-purge", () => {
    expect(BRAIN_IMPORT_PURGE_CRON).toBe("7 * * * *");
    const fn = brainImportPurgeFunction(new Inngest({ id: "test-app", isDev: true }), { purgeLane: async () => 0, enabledLanes: () => ["PKG"] }) as unknown as { opts: Record<string, unknown> };
    const opts = JSON.parse(JSON.stringify(fn.opts)) as Record<string, unknown>;
    expect(opts.id).toBe("brain-import-purge");
    expect(opts.triggers).toEqual([{ cron: BRAIN_IMPORT_PURGE_CRON }]);
    expect(opts.retries).toBe(BRAIN_IMPORT_PURGE_RETRIES);
  });
});

describe("handleBrainImportPurge", () => {
  it("purges each enabled lane once, in its own step, and reports counts", async () => {
    const purgeLane = vi.fn(async (l: string) => (l === "PKG" ? 2 : 0));
    const deps: BrainImportPurgeDeps = { purgeLane, enabledLanes: () => ["PKG", "PKG", "APK"] };
    const s = step();
    await expect(handleBrainImportPurge(deps, s.api)).resolves.toEqual({ lanes: 2, deleted: { PKG: 2, APK: 0 } });
    expect(s.ids).toEqual(["plan", "purge-PKG", "purge-APK"]);
    expect(purgeLane.mock.calls.map((c) => c[0])).toEqual(["PKG", "APK"]);
  });
  it("skips values that are not lane codes", async () => {
    const seen: string[] = [];
    const purgeLane = async (l: string) => (seen.push(l), 0);
    await handleBrainImportPurge({ purgeLane, enabledLanes: () => ["PKG", "pkg; drop", ""] }, step().api);
    expect(seen).toEqual(["PKG"]);
  });
  it("tries every lane, then fails with lane ids only", async () => {
    const purgeLane = vi.fn(async (l: string) => {
      if (l === "PKG") throw new Error("row text that must not leak");
      return 1;
    });
    const e = (await handleBrainImportPurge({ purgeLane, enabledLanes: () => ["PKG", "APK"] }, step().api).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(NonRetriableError);
    expect(e.message).toBe("brain.import_purge: failed for lane(s) PKG");
    expect(purgeLane.mock.calls.map((c) => c[0])).toEqual(["PKG", "APK"]);
  });
  it("does nothing without lanes", async () => {
    await expect(handleBrainImportPurge({ purgeLane: async () => 1, enabledLanes: () => [] }, step().api)).resolves.toEqual({ lanes: 0, deleted: {} });
  });
});
