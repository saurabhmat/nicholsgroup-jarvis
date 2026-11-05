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
    requireLane.mockResolvedValue({});
    listLanes.mockResolvedValue(LANES);
    expect(await loadLane("PKG")).toEqual({ laneId: "PKG", name: "Pub K Group", lanes: LANES });
    expect(requireLane).toHaveBeenCalledWith("PKG");
  });

  it("is a 404 when the guard passes but the lane is not in the user's list", async () => {
    requireLane.mockResolvedValue({});
    listLanes.mockResolvedValue([LANES[1]]);
    await expect(loadLane("PKG")).rejects.toThrow("NOT_FOUND");
  });

  it("is a 404 for a forbidden lane, the same as for an unknown one", async () => {
    requireLane.mockRejectedValue(new AuthError("forbidden"));
    await expect(loadLane("APK")).rejects.toThrow("NOT_FOUND");
    expect(listLanes).not.toHaveBeenCalled();
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
    requireLane.mockResolvedValue({});
    listLanes.mockRejectedValue(new Error("lanes query failed"));
    await expect(loadLane("PKG")).rejects.toThrow("lanes query failed");
  });

  it("treats other auth failures (for example step-up) as a 404, not as access", async () => {
    requireLane.mockRejectedValue(new AuthError("step_up_required"));
    await expect(loadLane("PKG")).rejects.toThrow("NOT_FOUND");
  });
});
