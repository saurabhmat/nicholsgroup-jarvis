// @vitest-environment jsdom
// T-230 B: each route's loading skeleton has the shape of its page, so the swap to content does not jump.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PageSkeleton } from "./page-skeleton";

afterEach(cleanup);

describe("PageSkeleton", () => {
  it("defaults to the Home grid: four figure blocks in one row and a 2/3 + 1/3 row", () => {
    render(<PageSkeleton />);
    const s = screen.getByTestId("page-skeleton");
    expect(s.dataset.variant).toBe("home");
    expect(s.querySelector(".lg\\:grid-cols-4")?.children).toHaveLength(4);
    expect(s.querySelector(".lg\\:col-span-2")).not.toBeNull();
  });

  it("Settings: a 200px sub-nav column beside the sections, no figure row", () => {
    render(<PageSkeleton variant="settings" />);
    const s = screen.getByTestId("page-skeleton");
    expect(s.querySelector(".lg\\:grid-cols-\\[200px_minmax\\(0\\,1fr\\)\\]")).not.toBeNull();
    expect(s.querySelector(".lg\\:grid-cols-4")).toBeNull();
  });

  it("Get started: the 280px rail from xl (as in the wizard) and one panel", () => {
    render(<PageSkeleton variant="setup" />);
    const s = screen.getByTestId("page-skeleton");
    expect(s.querySelector(".xl\\:grid-cols-\\[280px_minmax\\(0\\,1fr\\)\\]")).not.toBeNull();
    expect(s.querySelector(".lg\\:grid-cols-4")).toBeNull();
  });

  it("list pages: a column of cards; every variant is a busy status with no text but 'Loading'", () => {
    for (const variant of ["home", "settings", "setup", "list"] as const) {
      cleanup();
      render(<PageSkeleton variant={variant} />);
      const s = screen.getByRole("status");
      expect(s.getAttribute("aria-busy")).toBe("true");
      expect(s.textContent).toBe("Loading");
    }
  });
});
