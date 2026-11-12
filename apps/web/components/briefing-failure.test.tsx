// @vitest-environment jsdom
// T-234 part 0: the failure line shows fixed text; the hint is for admins only; no value or raw message anywhere.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FailureReason } from "./briefing-failure";

afterEach(cleanup);

describe("FailureReason", () => {
  it("shows the fixed text without a hint to a non-admin", () => {
    render(<FailureReason code="model_setting_invalid" />);
    expect(screen.getByTestId("briefing-failure").textContent).toBe("AI summary unavailable: AI model setting is invalid");
    expect(screen.queryByTestId("briefing-failure-hint")).toBeNull();
    expect(document.body.textContent).not.toContain("ANTHROPIC");
  });
  it("shows the hint to an admin, naming the variable", () => {
    render(<FailureReason code="model_setting_invalid" hint="Check ANTHROPIC_MODEL_ANALYSIS (or the request size)" />);
    expect(screen.getByTestId("briefing-failure-hint").textContent).toBe(" · Check ANTHROPIC_MODEL_ANALYSIS (or the request size)");
    expect(screen.getByTestId("briefing-failure-hint").className).not.toMatch(/\bblock\b/); // one line, never a stack (T-235)
  });
  it("an unknown or missing code reads generically", () => {
    render(<FailureReason code={null} />);
    expect(screen.getByTestId("briefing-failure").textContent).toBe("AI summary unavailable: Could not be prepared");
  });
});
