// The scheduled calendar sync's connection lister (T-130): lane-filtered, usable statuses, calendar providers only.
import { describe, expect, it } from "vitest";
import { createSyncTargetLister, CALENDAR_PROVIDERS, MAX_SYNC_TARGETS } from "./targets";

const A = "00000000-0000-4000-8000-000000000a01";

function fake(result: { data?: unknown; error?: unknown }) {
  const f: [string, string, unknown][] = [];
  const b: Record<string, unknown> = {};
  for (const op of ["eq", "in", "order", "limit"]) b[op] = (...a: unknown[]) => { f.push([op, String(a[0]), a[1]]); return op === "limit" ? Promise.resolve({ data: result.data ?? null, error: result.error ?? null }) : b; };
  let table = "";
  const client = { schema: (s: string) => ({ from: (t: string) => { table = `${s}.${t}`; return { select: (c: string) => { f.push(["select", c, null]); return b; } }; } }) };
  return { f, table: () => table, clientFor: async (lane: string) => { f.push(["lane", lane, null]); return client as never; } };
}

describe("listCalendarConnectionIds", () => {
  it("selects ids of the lane's active/degraded connections of calendar providers only", async () => {
    const x = fake({ data: [{ id: A }, { id: "bad" }, { nope: 1 }] });
    await expect(createSyncTargetLister(x.clientFor).listCalendarConnectionIds("PKG")).resolves.toEqual([A]);
    expect(x.table()).toBe("core.connections");
    expect(x.f).toContainEqual(["lane", "PKG", null]);
    expect(x.f).toContainEqual(["eq", "lane_id", "PKG"]);
    expect(x.f).toContainEqual(["in", "provider", [...CALENDAR_PROVIDERS]]);
    expect(x.f).toContainEqual(["in", "status", ["active", "degraded"]]);
    expect(x.f).toContainEqual(["limit", String(MAX_SYNC_TARGETS), undefined]);
    expect(CALENDAR_PROVIDERS).toEqual(["google"]);
  });

  it("fails with a generic error (no database detail) when the read fails or the lane is bad", async () => {
    const lister = createSyncTargetLister(fake({ error: { message: "relation x leaks" } }).clientFor);
    const err = (await lister.listCalendarConnectionIds("PKG").catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("leaks");
    await expect(lister.listCalendarConnectionIds("pkg" as never)).rejects.toThrow();
    await expect(createSyncTargetLister(async () => { throw new Error("no lane"); }).listCalendarConnectionIds("APK")).rejects.toThrow();
  });
});

describe("listQuickbooksConnectionIds (T-052)", () => {
  it("selects ids of the lane's active/degraded QuickBooks connections only", async () => {
    const x = fake({ data: [{ id: A }, { id: "bad" }] });
    await expect(createSyncTargetLister(x.clientFor).listQuickbooksConnectionIds("PKG")).resolves.toEqual([A]);
    expect(x.f).toContainEqual(["eq", "lane_id", "PKG"]);
    expect(x.f).toContainEqual(["in", "provider", ["quickbooks"]]);
    expect(x.f).toContainEqual(["in", "status", ["active", "degraded"]]);
  });

  it("fails generically and refuses a bad lane", async () => {
    const lister = createSyncTargetLister(fake({ error: { message: "relation x leaks" } }).clientFor);
    const err = (await lister.listQuickbooksConnectionIds("PKG").catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("leaks");
    await expect(lister.listQuickbooksConnectionIds("pkg" as never)).rejects.toThrow();
  });
});
