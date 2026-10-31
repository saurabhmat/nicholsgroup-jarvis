import { describe, expect, it } from "vitest";
import { actionApproved, connSyncRequested, LANE_EVENTS, systemHeartbeat } from "./events";

const CONN = "00000000-0000-4000-8000-000000000001";

describe("lane events (T-037)", () => {
  it("events without laneId do not compile", () => {
    // @ts-expect-error laneId is required
    connSyncRequested.create({ connectionId: CONN });
    // @ts-expect-error laneId is required
    actionApproved.create({ actionId: CONN });
    // @ts-expect-error laneId is required
    systemHeartbeat.create({});
    expect(connSyncRequested.create({ laneId: "PKG", connectionId: CONN }).name).toBe("conn/sync.requested");
  });

  it("every lane event refuses a missing or invalid lane id at runtime", async () => {
    for (const event of LANE_EVENTS) {
      for (const data of [{}, { laneId: "pkg" }, { laneId: "PKG;--" }, { laneId: "" }]) {
        await expect((event.create as (d: unknown) => { validate(): Promise<unknown> })(data).validate()).rejects.toThrow();
      }
    }
  });

  it("validates ids and refuses unknown fields (no content in payloads)", async () => {
    await expect(connSyncRequested.create({ laneId: "PKG", connectionId: CONN }).validate()).resolves.toBeUndefined();
    await expect(connSyncRequested.create({ laneId: "PKG", connectionId: "not-a-uuid" }).validate()).rejects.toThrow();
    await expect(
      (actionApproved.create as (d: unknown) => { validate(): Promise<unknown> })({ laneId: "PKG", actionId: CONN, body: "x" }).validate(),
    ).rejects.toThrow();
  });
});
