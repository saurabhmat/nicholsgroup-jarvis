// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/lane-page", () => ({ loadLane: async () => ({ laneId: "PKG", name: "Pub K Group", lanes: [] }) }));
import { ModulePage } from "./module-page";

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
