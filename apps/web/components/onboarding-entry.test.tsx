// @vitest-environment jsdom
// T-226: the phone entry point. Home banner: only while incomplete and only with a readable count. (T-271: the More row is gone.)
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OnboardingBanner } from "./onboarding-entry";

afterEach(cleanup);

describe("Home banner", () => {
  it("shows 'Finish setting up Jarvis (3 of 10) →' linking to the onboarding while incomplete", () => {
    render(<OnboardingBanner laneId="PKG" progress={{ done: 3, total: 10 }} />);
    const b = screen.getByTestId("onboarding-banner");
    expect(b.textContent).toBe("Finish setting up Jarvis (3 of 10) →");
    expect(b.getAttribute("href")).toBe("/PKG/onboarding");
    expect(b.className).toContain("md:hidden"); // phone only
  });
  it("is hidden when complete, when the count is unreadable, and for a user without the brain view", () => {
    for (const progress of [{ done: 10, total: 10 }, { done: null, total: 10 }, null]) {
      const { container, unmount } = render(<OnboardingBanner laneId="PKG" progress={progress} />);
      expect(container.textContent).toBe("");
      unmount();
    }
  });
});
