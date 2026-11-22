// T-265: the landing company. The list is ordered by code; a company that limits itself to a module list (a mail-only company) must not
// become the landing page of a user who also has a company that shows every module. Synthetic lanes.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/guards", () => ({ guards: async () => ({}) }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
const { firstLaneId } = await import("@/lib/landing");

const rows: Record<string, unknown> = {};
const guardsFor = (lanes: string[]) => ({
  listLanes: async () => lanes.map((laneId) => ({ laneId, name: laneId })),
  requireLane: async (laneId: string) => {
    if (rows[laneId] === "denied") throw new Error("not allowed");
    return { client: { schema: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rows[laneId] ?? null, error: null }) }) }) }) }) } };
  },
});
const LIMITED = { modules: ["comms"], limited: true, news: null };
const FULL = { modules: ["finance"], limited: null, news: null };

describe("firstLaneId", () => {
  it("puts a limited company after a full one, though its code sorts first", async () => {
    rows.AA = LIMITED;
    rows.BB = FULL;
    expect(await firstLaneId(guardsFor(["AA", "BB"]) as never)).toBe("BB");
  });
  it("keeps the plain order when no company is limited, when all are, or when a config cannot be read", async () => {
    rows.AA = FULL;
    rows.BB = FULL;
    expect(await firstLaneId(guardsFor(["AA", "BB"]) as never)).toBe("AA");
    rows.AA = LIMITED;
    rows.BB = LIMITED;
    expect(await firstLaneId(guardsFor(["AA", "BB"]) as never)).toBe("AA");
    rows.AA = "denied";
    rows.BB = FULL;
    expect(await firstLaneId(guardsFor(["AA", "BB"]) as never)).toBe("AA");
  });
  it("a user with one company, or none, reads nothing more", async () => {
    expect(await firstLaneId(guardsFor(["AA"]) as never)).toBe("AA");
    expect(await firstLaneId(guardsFor([]) as never)).toBeUndefined();
  });
});
