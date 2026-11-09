import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { GROUPS } from "@nichols/brain/interview";

const state = vi.hoisted(() => ({ groups: [] as { id: string; title: string; complete: boolean }[], brainLanes: ["PKG"] as string[], info: true, progressThrows: false, home: null as string | null, homeThrows: false, clientFor: null as null | ((l: string) => Promise<unknown>) }));
vi.mock("@/lib/brain-interview", () => ({
  brainLanes: async (_c: unknown, _u: string, view: string) => (view === "brain" ? state.brainLanes : []),
  readLaneInfo: async (_c: unknown, laneId: string) => (state.info ? { laneId, name: laneId, mailboxes: [], kpis: [], connected: null, policy: { write_actions_allowed: [], store_outbound_drafts: false, llm_allowed_categories: [] }, financeView: false } : null),
  timezoneList: () => ["UTC"],
}));
vi.mock("@nichols/brain/server", () => ({
  createBrainStore: (deps: { clientFor: (l: string) => Promise<unknown> }) => {
    state.clientFor = deps.clientFor;
    return {
      findHomeLane: async () => {
        if (state.homeThrows) throw new Error("db down");
        return state.home;
      },
    };
  },
  loadProgress: async (env: { ctx: { home: string } }) => {
    await state.clientFor?.(env.ctx.home); // reading the home lane's pages opens that lane through the router
    if (state.progressThrows) throw new Error("db down");
    return state.groups;
  },
}));

import { loadOnboarding, sectionIdFrom } from "./onboarding";

const owner = { requireRole: async () => ({ session: { userId: "u1" }, client: {} }), requireLane: async () => ({}), listLanes: async () => [] } as never;
const viewer = { requireRole: async () => { throw new AuthError("forbidden"); }, requireLane: async () => ({}), listLanes: async () => [] } as never;
const now = new Date("2026-11-09T12:00:00Z");

describe("setup progress (T-226)", () => {
  beforeEach(() => {
    state.home = null;
    state.homeThrows = false;
    state.progressThrows = false;
    state.info = true;
    state.brainLanes = ["PKG"];
  });

  it("counts completed sections out of the bank's section count", async () => {
    state.groups = GROUPS.map((g, i) => ({ id: g.id, title: g.title, complete: i < 3 }));
    const v = await loadOnboarding(owner, "PKG", now);
    expect(v).toMatchObject({ done: 3, total: GROUPS.length, nextSectionId: GROUPS[3]?.id });
    expect(v?.sections).toHaveLength(10);
  });

  it("is null for a non-owner and for a lane without the brain view (the entry is not drawn)", async () => {
    expect(await loadOnboarding(viewer, "PKG", now)).toBeNull();
    state.brainLanes = [];
    expect(await loadOnboarding(owner, "PKG", now)).toBeNull();
    state.brainLanes = ["PKG"];
    state.info = false;
    expect(await loadOnboarding(owner, "PKG", now)).toBeNull(); // lane facts unreadable: fail closed
    state.info = true;
  });

  it("keeps the entry (no count) when the state cannot be read", async () => {
    state.progressThrows = true;
    const v = await loadOnboarding(owner, "PKG", now);
    expect(v?.done).toBeNull();
    expect(v?.total).toBe(GROUPS.length);
  });

  it("cross-lane: a guard that allows only AAA gives nothing for BBB, and the owner check was asked about BBB", async () => {
    state.progressThrows = false;
    state.brainLanes = ["AAA"];
    state.groups = GROUPS.map((g) => ({ id: g.id, title: g.title, complete: true }));
    const asked: string[] = [];
    const guard = {
      requireRole: async (l: string) => {
        asked.push(`role:${l}`);
        if (l !== "AAA") throw new AuthError("forbidden");
        return { session: { userId: "u1" }, client: {} };
      },
      requireLane: async (l: string) => {
        asked.push(`lane:${l}`);
        if (l !== "AAA") throw new AuthError("forbidden");
        return { client: {} };
      },
      listLanes: async () => [],
    } as never;
    expect(await loadOnboarding(guard, "BBB", now)).toBeNull();
    expect(asked).toEqual(["role:BBB"]);
    expect((await loadOnboarding(guard, "AAA", now))?.done).toBe(GROUPS.length);
  });

  const lanes = (allowed: string[], asked: string[]) =>
    ({
      requireRole: async (l: string) => ({ session: { userId: "u1" }, client: {}, laneId: l }),
      requireLane: async (l: string) => {
        asked.push(`lane:${l}`);
        if (!allowed.includes(l)) throw new AuthError("forbidden");
        return { client: {} };
      },
      listLanes: async () => [],
    }) as never;

  it("a home lane the user cannot open with the brain view gives nothing and is never opened", async () => {
    state.progressThrows = false;
    state.brainLanes = ["AAA"];
    state.home = "ZZZ";
    state.groups = GROUPS.map((g) => ({ id: g.id, title: g.title, complete: true }));
    const asked: string[] = [];
    expect(await loadOnboarding(lanes(["AAA"], asked), "AAA", now)).toBeNull();
    expect(asked).not.toContain("lane:ZZZ");
  });

  it("a home lane in the brain list that the router refuses gives the degraded view (no count)", async () => {
    state.brainLanes = ["AAA", "AAA2"];
    state.home = "AAA2";
    const v = await loadOnboarding(lanes(["AAA"], []), "AAA", now);
    expect(v?.done).toBeNull();
  });

  it("an unreadable home-lane lookup gives the degraded view, not a guess at the current lane", async () => {
    state.brainLanes = ["AAA"];
    state.home = null;
    state.homeThrows = true;
    expect((await loadOnboarding(owner, "AAA", now))?.done).toBeNull();
    state.homeThrows = false;
  });

  it("accepts only the bank's section ids from the URL", () => {
    expect(sectionIdFrom("A-2")).toBe("A-2");
    expect(sectionIdFrom("B-6")).toBe("B-6");
    expect(sectionIdFrom("nope")).toBeUndefined();
    expect(sectionIdFrom("A-2 ")).toBeUndefined();
    expect(sectionIdFrom(["A-1", "A-2"])).toBeUndefined();
    expect(sectionIdFrom(undefined)).toBeUndefined();
    expect(sectionIdFrom("<script>")).toBeUndefined();
  });
});
