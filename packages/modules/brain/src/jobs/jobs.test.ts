import { describe, expect, it } from "vitest";
import type { BrainDb } from "../server/store";
import { BRAIN_RETENTION, ImportPurgeError, createImportPurge } from "./index";

const client = (reply: { data: unknown; error: { code?: string } | null }, calls: unknown[] = []): BrainDb =>
  ({
    schema: (name: string) => ({
      rpc: async (fn: string, args: unknown) => {
        calls.push([name, fn, args]);
        return reply;
      },
    }),
  }) as unknown as BrainDb;

describe("brain import purge job", () => {
  it("calls core.brain_import_purge for the lane through the job client and returns the count", async () => {
    const calls: unknown[] = [];
    const seen: string[] = [];
    const job = createImportPurge({ clientFor: async (l) => (seen.push(l), client({ data: 3, error: null }, calls)) });
    await expect(job.purgeLane("PKG")).resolves.toBe(3);
    expect(seen).toEqual(["PKG"]);
    expect(calls).toEqual([["core", "brain_import_purge", { p_lane: "PKG" }]]);
  });
  it("fails closed with no detail: bad lane, router refusal, database error, odd reply", async () => {
    const mk = (c: BrainDb | Error) => createImportPurge({ clientFor: async () => (c instanceof Error ? Promise.reject(c) : c) });
    await expect(mk(client({ data: 1, error: null })).purgeLane("pkg")).rejects.toBeInstanceOf(ImportPurgeError);
    await expect(mk(new Error("secret detail")).purgeLane("PKG")).rejects.toThrow("brain import purge unavailable");
    await expect(mk(client({ data: null, error: { code: "42501" } })).purgeLane("PKG")).rejects.toBeInstanceOf(ImportPurgeError);
    await expect(mk(client({ data: -1, error: null })).purgeLane("PKG")).rejects.toBeInstanceOf(ImportPurgeError);
    await expect(mk(client({ data: "3", error: null })).purgeLane("PKG")).rejects.toBeInstanceOf(ImportPurgeError);
  });
});

describe("retention catalog (T-210 follow-up)", () => {
  it("declares every brain table exactly once, with a reason, and imports by their own job", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "supabase", "core", "supabase", "migrations");
    const created = new Set<string>();
    for (const f of readdirSync(migrations).filter((x) => x.endsWith(".sql"))) {
      for (const m of readFileSync(path.join(migrations, f), "utf8").matchAll(/create table (brain\.[a-z_]+)/g)) created.add(m[1] as string);
    }
    const ids = BRAIN_RETENTION.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...created].sort()).toEqual([...ids].sort());
    for (const d of BRAIN_RETENTION) {
      expect(d.reason.length).toBeGreaterThan(10);
      if (d.rule === "own_job") expect(d.job).toBe("brain-import-purge");
    }
    expect(BRAIN_RETENTION.filter((d) => d.rule === "own_job").map((d) => d.id).sort()).toEqual(["brain.import_candidates"]);
  });
});
