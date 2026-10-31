import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LaneChip } from "./lane-chip";

describe("LaneChip", () => {
  it("shows the lane code", () => {
    render(<LaneChip code="PKG" />);
    const chip = screen.getByText("PKG").closest("[data-slot=lane-chip]");
    expect(chip).not.toBeNull();
  });

  it("exposes the lane name once to assistive tech", () => {
    const { container } = render(<LaneChip code="PKG" name="Pub K Group" />);
    const chip = container.querySelector("[data-slot=lane-chip]");
    expect(chip?.textContent).toContain("PKG");
    expect(chip?.textContent).toContain("Pub K Group");
    expect(chip?.hasAttribute("title")).toBe(false);
  });
});
