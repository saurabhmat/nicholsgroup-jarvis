// @vitest-environment jsdom
// T-226: the phone entry points. Home banner: only while incomplete and only with a readable count; More row: first, badge, check.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OnboardingBanner, OnboardingMoreRow } from "./onboarding-entry";

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

describe("More row", () => {
  const row = (progress: Parameters<typeof OnboardingMoreRow>[0]["progress"]) =>
    render(
      <ul>
        <OnboardingMoreRow laneId="PKG" progress={progress} />
        <li>Finance</li>
      </ul>,
    );
  it("is the first row with the badge while incomplete", () => {
    row({ done: 3, total: 10 });
    const first = screen.getAllByRole("listitem")[0] as HTMLElement;
    expect(first.textContent).toBe("Get started3 of 10");
    expect(first.querySelector("a")?.getAttribute("href")).toBe("/PKG/onboarding");
  });
  it("shows the badge for 0 of 10 and no badge when the count is unreadable", () => {
    const { unmount } = row({ done: 0, total: 10 });
    expect((screen.getAllByRole("listitem")[0] as HTMLElement).textContent).toBe("Get started0 of 10");
    unmount();
    row({ done: null, total: 10 });
    expect((screen.getAllByRole("listitem")[0] as HTMLElement).textContent).toBe("Get started");
  });
  it("says AI brain with a check when everything is done", () => {
    row({ done: 10, total: 10 });
    const first = screen.getAllByRole("listitem")[0] as HTMLElement;
    expect(first.textContent).toContain("AI brain");
    expect(screen.getByRole("img", { name: "Setup complete" })).toBeTruthy();
    expect(first.textContent).not.toContain("of 10");
  });
  it("is absent for a user without the brain view", () => {
    row(null);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
