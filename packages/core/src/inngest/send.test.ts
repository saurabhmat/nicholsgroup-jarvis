// sendLaneEvent (T-037 review L1, L4): validates against the registered schema and the served lanes.
import { describe, expect, it, vi } from "vitest";

const sent: unknown[] = [];
vi.mock("../env/server", () => ({
  getServerEnv: () => ({ APP_ENV: "local", ENABLED_LANES: ["PKG"], NEXT_PUBLIC_APP_URL: "http://localhost:3000" }),
  isDevelopmentRuntime: () => true,
  getInngestEnv: () => ({ configured: false, missing: [] }),
}));
vi.mock("inngest", async (orig) => {
  const real = await orig<typeof import("inngest")>();
  class FakeInngest extends real.Inngest {
    override send = vi.fn(async (payload: unknown) => {
      sent.push(payload);
      return { ids: ["x"] };
    }) as never;
  }
  return { ...real, Inngest: FakeInngest };
});

const { sendLaneEvent, connSyncRequested, platformFunctions, getInngest, LANE_EVENTS } = await import("./index");
const CONN = "00000000-0000-4000-8000-000000000001";

describe("sendLaneEvent", () => {
  it("sends a valid event for a served lane (name and data only)", async () => {
    await sendLaneEvent(connSyncRequested.create({ laneId: "PKG", connectionId: CONN }));
    expect(sent.at(-1)).toEqual({ name: "conn/sync.requested", data: { laneId: "PKG", connectionId: CONN } });
  });

  it("validates against the registered schema, not the caller's validate()", async () => {
    const forged = { name: "conn/sync.requested", data: { laneId: "PKG", connectionId: "nope" }, validate: async () => {} };
    await expect(sendLaneEvent(forged)).rejects.toThrow("invalid event data");
    await expect(sendLaneEvent({ name: "made/up", data: { laneId: "PKG" } })).rejects.toThrow("unknown event");
  });

  it("refuses lanes this deployment does not serve", async () => {
    await expect(sendLaneEvent(connSyncRequested.create({ laneId: "NL", connectionId: CONN }))).rejects.toThrow("lane not served");
  });
});

describe("registered functions", () => {
  it("are triggered only by lane events (validated on receipt)", () => {
    // Triggers must be the registered event types themselves (they carry the schema), never bare event names.
    const registered = new Set<unknown>(LANE_EVENTS);
    for (const fn of platformFunctions(getInngest())) {
      const triggers = (fn as unknown as { opts: { triggers?: unknown[] } }).opts.triggers ?? [];
      expect(triggers.length).toBeGreaterThan(0);
      for (const t of triggers) expect(registered.has(t)).toBe(true);
    }
  });
});
