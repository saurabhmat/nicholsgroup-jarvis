// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const lane = vi.hoisted(() => ({ calls: 0, fail: false }));
vi.mock("@/lib/lane-page", () => ({
  loadLane: async () => {
    lane.calls += 1;
    if (lane.fail) throw new Error("NOT_FOUND");
    return { laneId: "PKG", name: "Pub K Group", lanes: [] };
  },
}));
import { LaneName, ModulePage, ShellModulePage } from "./module-page";

afterEach(cleanup);
const params = Promise.resolve({ laneId: "PKG" });

describe("ModulePage", () => {
  it("shows the heading and the placeholder by default", async () => {
    render(await ModulePage({ module: "settings", params }));
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(screen.getByText("Settings are not set up yet")).toBeTruthy();
  });
  it("keeps the heading and drops the placeholder when asked", async () => {
    render(await ModulePage({ module: "settings", params, placeholder: false }));
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(screen.queryByText("Settings are not set up yet")).toBeNull();
  });
});

describe("ShellModulePage (T-276: Contacts and Messages)", () => {
  it("is not async: the heading and the card are drawn with no lane read at all (part of the prefetched shell)", () => {
    lane.calls = 0;
    expect(ShellModulePage.constructor.name).toBe("Function");
    const tree = ShellModulePage({ module: "contacts", params });
    expect(lane.calls).toBe(0);
    render(tree);
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.getByText("Contacts are not set up yet")).toBeTruthy();
  });
  it("the company name (and the lane check) comes from a small async child: a refused lane still throws there", async () => {
    lane.fail = false;
    expect(await LaneName({ params })).toBe("Pub K Group");
    lane.fail = true;
    await expect(LaneName({ params })).rejects.toThrow("NOT_FOUND");
    lane.fail = false;
  });
});
