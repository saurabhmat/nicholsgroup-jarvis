import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LaneChip } from "./lane-chip";

describe("LaneChip", () => {
  it("shows the lane code", () => {
    render(<LaneChip code="PKG" />);
    const chip = screen.getByText("PKG").closest("[data-slot=lane-chip]");
    expect(chip).not.toBeNull();
  });

  it("exposes the lane name to assistive tech and as a tooltip", () => {
    render(<LaneChip code="PKG" name="Pub K Group" />);
    const chip = screen.getByTitle("Pub K Group");
    expect(chip.textContent).toContain("PKG");
    expect(chip.textContent).toContain("Pub K Group");
  });
});
