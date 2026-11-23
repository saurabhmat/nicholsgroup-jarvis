// T-276: the spans a hosted measurement (SERVER_TIMING=1) needs: the gate's config read, the layout's first name, the calendar read. (The Microsoft reply check's span is asserted in Home's test.)
import { beforeEach, describe, expect, it, vi } from "vitest";

const spans = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock("@/lib/timed", () => ({ timed: async <T,>(n: string, f: () => Promise<T> | T) => (spans.names.push(n), f()) }));
vi.mock("@/lib/guards", () => ({ guards: async () => ({ requireLane: async () => ({ client: { schema: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }, session: { userId: "u" } }) }) }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
const { laneGate } = await import("@/lib/lane-modules");
const { calendarFor } = await import("@/lib/calendar-page");
const { firstNameFor } = await import("@/lib/first-name");

beforeEach(() => {
  spans.names = [];
});

describe("timing spans (T-276)", () => {
  it("the gate read, the first name and the calendar read are each timed under a fixed name", async () => {
    await laneGate("PKG");
    await firstNameFor({ requireLane: async () => ({ client: {}, session: { userId: "u" } }) } as never, "PKG", async () => undefined);
    await calendarFor({ requireLane: async () => ({ client: {}, session: { userId: "u" } }) } as never, "PKG", { view: "week", from: new Date(), to: new Date() } as never, async () => ({ state: "not_connected" }));
    expect(spans.names).toEqual(["gate.read", "load.first_name", "load.calendar"]);
  });
});
