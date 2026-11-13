// T-231c: the schedule is off unless lane_config.briefing.schedule_enabled; only the lane's New York hour; owners are
// re-checked for the briefing, comms and calendar views on every run.
import { describe, expect, it } from "vitest";
import { dueOwners, refreshOwners, type ClientFor } from "./briefing-schedule";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const AT_7_NY = new Date("2026-11-11T12:10:00Z");

function client(config: unknown, views: Record<string, string[]> = {}): ClientFor {
  const c = {
    schema: () => ({
      from: (t: string) => ({
        select: () => ({
          eq: () =>
            t === "memberships"
              ? { eq: async () => ({ data: [{ user_id: A }, { user_id: B }], error: null }) }
              : { maybeSingle: async () => ({ data: { config }, error: null }) },
        }),
      }),
      rpc: async (_fn: string, args: { p_uid: string; p_view: string }) => ({ data: (views[args.p_uid] ?? []).includes(args.p_view) ? ["PKG"] : [], error: null }),
    }),
  };
  return async () => c as never;
}

describe("dueOwners", () => {
  it("off by default", async () => {
    await expect(dueOwners(client({}), "PKG", AT_7_NY)).resolves.toEqual([]);
  });
  it("on, at the lane's hour: owners holding all three views only", async () => {
    const cfg = { briefing: { schedule_enabled: true, time: "07:00" } };
    const views = { [A]: ["briefing", "comms", "calendar"], [B]: ["briefing", "comms"] };
    await expect(dueOwners(client(cfg, views), "PKG", AT_7_NY)).resolves.toEqual([A]);
    await expect(dueOwners(client(cfg, views), "PKG", new Date("2026-11-11T14:10:00Z"))).resolves.toEqual([]);
  });
  it("defaults (D-32): 06:30 New York on weekdays only", async () => {
    const cfg = { briefing: { schedule_enabled: true } };
    const views = { [A]: ["briefing", "comms", "calendar"] };
    await expect(dueOwners(client(cfg, views), "PKG", new Date("2026-11-11T11:30:00Z"))).resolves.toEqual([A]); // Wed 06:30
    await expect(dueOwners(client(cfg, views), "PKG", new Date("2026-11-14T11:30:00Z"))).resolves.toEqual([]); // Sat 06:30
  });
});

describe("refreshOwners (T-238: the refresh after new mail follows the schedule switch)", () => {
  const views = { [A]: ["briefing", "comms", "calendar"], [B]: ["briefing", "comms"] };
  it("schedule off (default, or explicitly false): nobody, so no automatic refresh", async () => {
    await expect(refreshOwners(client({}, views), "PKG")).resolves.toEqual([]);
    await expect(refreshOwners(client({ briefing: { schedule_enabled: false } }, views), "PKG")).resolves.toEqual([]);
  });
  it("schedule on: owners holding all three views, at any hour or day (the run claim still gates)", async () => {
    await expect(refreshOwners(client({ briefing: { schedule_enabled: true } }, views), "PKG")).resolves.toEqual([A]);
  });
  it("an unreadable config is off", async () => {
    const broken: ClientFor = async () => ({ schema: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "x" } }) }) }) }) }) }) as never;
    await expect(refreshOwners(broken, "PKG")).resolves.toEqual([]);
  });
});
