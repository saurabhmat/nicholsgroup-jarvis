// briefing.refresh (T-238): runs only through the injected claim-gated refresh; a refusal never reaches the model; lanes stay apart.
import { NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { handleBriefingRefresh, type BriefingRefreshDeps, type BriefingRefreshOutcome } from "./briefing-refresh";

const O1 = "00000000-0000-4000-8000-0000000000c1";
const O2 = "00000000-0000-4000-8000-0000000000c2";
const NOW = new Date("2026-11-05T12:22:00Z");
const step = { run: async <T,>(_id: string, fn: () => T | Promise<T>) => fn() };

const deps = (over: Partial<BriefingRefreshDeps> = {}) => ({
  enabledLanes: () => ["PKG"],
  owners: vi.fn<BriefingRefreshDeps["owners"]>(async () => [O1, O2]),
  ...over,
  refresh: vi.fn<BriefingRefreshDeps["refresh"]>(over.refresh ?? (async (): Promise<BriefingRefreshOutcome> => "ran")),
});

describe("handleBriefingRefresh", () => {
  it("asks the claim-gated refresh once per owner of the event's lane", async () => {
    const d = deps();
    await expect(handleBriefingRefresh(d, { laneId: "PKG" }, "slot1", step, NOW)).resolves.toMatchObject({ ran: 2, refused: 0 });
    expect(d.owners).toHaveBeenCalledWith("PKG");
    expect(d.refresh.mock.calls.map((c) => [c[0], c[1]])).toEqual([["PKG", O1], ["PKG", O2]]);
  });

  it("a refusal by the claim (stale, cap, running) is counted and nothing else happens", async () => {
    const d = deps({ refresh: async () => "refused" });
    await expect(handleBriefingRefresh(d, { laneId: "PKG" }, "s", step, NOW)).resolves.toMatchObject({ ran: 0, refused: 2 });
  });

  it("does nothing for a lane this deployment does not serve, and refuses invalid event data", async () => {
    const d = deps();
    await expect(handleBriefingRefresh(d, { laneId: "APK" }, "s", step, NOW)).resolves.toMatchObject({ lane: "not_served" });
    expect(d.owners).not.toHaveBeenCalled();
    for (const bad of [{}, { laneId: "pkg" }, { laneId: "PKG", extra: 1 }, null]) {
      await expect(handleBriefingRefresh(d, bad, "s", step, NOW)).rejects.toBeInstanceOf(NonRetriableError);
    }
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it("one owner failing does not stop the next; the run then fails with counts and the lane id only", async () => {
    const d = deps({
      refresh: async (_l, owner) => {
        if (owner === O1) throw new Error("model said secret text");
        return "ran";
      },
    });
    const err = (await handleBriefingRefresh(d, { laneId: "PKG" }, "s", step, NOW).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(NonRetriableError);
    expect(err.message).not.toContain("secret");
    expect(d.refresh).toHaveBeenCalledTimes(2);
  });

  it("drops owner ids that are not uuids", async () => {
    const d = deps({ owners: async () => [O1, "x"] });
    await handleBriefingRefresh(d, { laneId: "PKG" }, "s", step, NOW);
    expect(d.refresh).toHaveBeenCalledTimes(1);
  });
});
