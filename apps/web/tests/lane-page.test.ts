import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";

// next/navigation throws to stop rendering; mirror that with recognisable errors.
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));

const requireLane = vi.fn();
const listLanes = vi.fn();
vi.mock("@/lib/guards", () => ({ guards: async () => ({ requireLane, listLanes }) }));

const { loadLane } = await import("@/lib/lane-page");

const LANES = [
  { laneId: "PKG", name: "Pub K Group" },
  { laneId: "APK", name: "Ask Pub K" },
];

beforeEach(() => {
  requireLane.mockReset();
  listLanes.mockReset();
});

describe("loadLane", () => {
  it("returns the lane and the allowed lanes when the guard passes and the lane is listed", async () => {
    requireLane.mockResolvedValue({ session: { userId: "u1" } });
    listLanes.mockResolvedValue(LANES);
    expect(await loadLane("PKG")).toEqual({ laneId: "PKG", name: "Pub K Group", lanes: LANES, userId: "u1" });
    expect(requireLane).toHaveBeenCalledWith("PKG");
  });

  it("is a 404 when the guard passes but the lane is not in the user's list", async () => {
    requireLane.mockResolvedValue({ session: { userId: "u1" } });
    listLanes.mockResolvedValue([LANES[1]]);
    await expect(loadLane("PKG")).rejects.toThrow("NOT_FOUND");
  });

  it("is a 404 for a forbidden lane, the same as for an unknown one", async () => {
    requireLane.mockRejectedValue(new AuthError("forbidden"));
    listLanes.mockResolvedValue(LANES); // T-230 A: asked at the same time as the lane check; a refused lane is a 404 whatever the list says
    await expect(loadLane("APK")).rejects.toThrow("NOT_FOUND");
  });

  it("asks for the lane check and the lane list at the same time (T-230 A)", async () => {
    const started: string[] = [];
    const release: (() => void)[] = [];
    const gate = () => new Promise<void>((r) => release.push(r));
    requireLane.mockImplementation(async () => {
      started.push("check");
      await gate();
      return { session: { userId: "u1" } };
    });
    listLanes.mockImplementation(async () => {
      started.push("list");
      await gate();
      return LANES;
    });
    const loading = loadLane("PKG");
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual(["check", "list"]); // both under way before either has answered
    release.forEach((r) => r());
    await loading;
  });

  it("when both fail, the lane check's error decides (as when they ran one after the other)", async () => {
    requireLane.mockRejectedValue(new AuthError("forbidden"));
    listLanes.mockRejectedValue(new Error("lanes query failed"));
    await expect(loadLane("APK")).rejects.toThrow("NOT_FOUND");
  });

  it("sends a signed-out user to sign-in", async () => {
    requireLane.mockRejectedValue(new AuthError("no_session"));
    await expect(loadLane("PKG")).rejects.toThrow("REDIRECT /sign-in");
  });

  it("sends an AAL1 user to the authenticator step", async () => {
    requireLane.mockRejectedValue(new AuthError("mfa_required"));
    await expect(loadLane("PKG")).rejects.toThrow("REDIRECT /mfa");
  });

  it("lets an outage propagate: never a 404 and never access", async () => {
    requireLane.mockRejectedValue(new Error("auth service unavailable"));
    await expect(loadLane("PKG")).rejects.toThrow("auth service unavailable");
    requireLane.mockResolvedValue({ session: { userId: "u1" } });
    listLanes.mockRejectedValue(new Error("lanes query failed"));
    await expect(loadLane("PKG")).rejects.toThrow("lanes query failed");
  });

  it("treats other auth failures (for example step-up) as a 404, not as access", async () => {
    requireLane.mockRejectedValue(new AuthError("step_up_required"));
    await expect(loadLane("PKG")).rejects.toThrow("NOT_FOUND");
  });
});
