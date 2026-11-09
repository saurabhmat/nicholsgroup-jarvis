import { describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { GROUPS } from "@nichols/brain/interview";

const state = vi.hoisted(() => ({ groups: [] as { id: string; title: string; done: boolean }[], buildRefused: false, stateThrows: false }));
vi.mock("@/lib/brain-interview", () => ({
  buildEnv: async () => (state.buildRefused ? { refused: "forbidden" } : { env: {} }),
}));
vi.mock("@nichols/brain/server", () => ({
  loadInterviewState: async () => {
    if (state.stateThrows) throw new Error("db down");
    return { groups: state.groups };
  },
}));

import { loadOnboarding, sectionIdFrom } from "./onboarding";

const owner = { requireRole: async () => ({ session: { userId: "u1" } }), requireLane: async () => ({}), listLanes: async () => [] } as never;
const viewer = { requireRole: async () => { throw new AuthError("forbidden"); }, requireLane: async () => ({}), listLanes: async () => [] } as never;
const now = new Date("2026-11-09T12:00:00Z");

describe("setup progress (T-226)", () => {
  it("counts completed sections out of the bank's section count", async () => {
    state.buildRefused = false;
    state.stateThrows = false;
    state.groups = GROUPS.map((g, i) => ({ id: g.id, title: g.title, done: i < 3 }));
    const v = await loadOnboarding(owner, "PKG", now);
    expect(v).toMatchObject({ done: 3, total: GROUPS.length, nextSectionId: GROUPS[3]?.id });
    expect(v?.sections).toHaveLength(10);
  });

  it("is null for a non-owner and for a lane without the brain view (the entry is not drawn)", async () => {
    expect(await loadOnboarding(viewer, "PKG", now)).toBeNull();
    state.buildRefused = true;
    expect(await loadOnboarding(owner, "PKG", now)).toBeNull();
  });

  it("keeps the entry (no count) when the state cannot be read", async () => {
    state.buildRefused = false;
    state.stateThrows = true;
    const v = await loadOnboarding(owner, "PKG", now);
    expect(v?.done).toBeNull();
    expect(v?.total).toBe(GROUPS.length);
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
