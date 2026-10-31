import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Input } from "./input";
import { Label } from "./label";

describe("Input and Label", () => {
  it("renders a labelled input with its attributes", () => {
    render(
      <>
        <Label htmlFor="code">Code</Label>
        <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" aria-invalid />
      </>,
    );
    const input = screen.getByLabelText("Code");
    expect(input.getAttribute("type")).toBe("text");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.className).toContain("aria-invalid:border-destructive");
  });
});
