import { describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { GROUPS } from "@nichols/brain/interview";

const state = vi.hoisted(() => ({ groups: [] as { id: string; title: string; complete: boolean }[], brainLanes: ["PKG"] as string[], info: true, progressThrows: false }));
vi.mock("@/lib/brain-interview", () => ({
  brainLanes: async (_c: unknown, _u: string, view: string) => (view === "brain" ? state.brainLanes : []),
  readLaneInfo: async (_c: unknown, laneId: string) => (state.info ? { laneId, name: laneId, mailboxes: [], kpis: [], connected: null, policy: { write_actions_allowed: [], store_outbound_drafts: false, llm_allowed_categories: [] }, financeView: false } : null),
  timezoneList: () => ["UTC"],
}));
vi.mock("@nichols/brain/server", () => ({
  createBrainStore: () => ({ findHomeLane: async () => null }),
  loadProgress: async () => {
    if (state.progressThrows) throw new Error("db down");
    return state.groups;
  },
}));

import { loadOnboarding, sectionIdFrom } from "./onboarding";

const owner = { requireRole: async () => ({ session: { userId: "u1" }, client: {} }), requireLane: async () => ({}), listLanes: async () => [] } as never;
const viewer = { requireRole: async () => { throw new AuthError("forbidden"); }, requireLane: async () => ({}), listLanes: async () => [] } as never;
const now = new Date("2026-11-09T12:00:00Z");

describe("setup progress (T-226)", () => {
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
