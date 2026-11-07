import { describe, expect, it } from "vitest";
import type { BrainDb } from "../server/store";
import { ImportPurgeError, createImportPurge } from "./index";

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
