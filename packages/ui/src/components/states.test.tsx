import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./empty-state";
import { ErrorState } from "./error-state";

describe("EmptyState", () => {
  it("renders title, description and action as a status region", () => {
    render(
      <EmptyState
        title="No invoices"
        description="Nothing is overdue this week."
        action={<a href="/finance/ar-ap">Open AR/AP</a>}
      />,
    );
    const region = screen.getByRole("status");
    expect(region.textContent).toContain("No invoices");
    expect(region.textContent).toContain("Nothing is overdue this week.");
    expect(screen.getByRole("link", { name: "Open AR/AP" })).toBeTruthy();
  });
});

describe("ErrorState", () => {
  it("renders as an alert with title and optional description", () => {
    render(<ErrorState title="Could not load figures" />);
    const region = screen.getByRole("alert");
    expect(region.textContent).toContain("Could not load figures");
  });

  it("can be a polite status region", () => {
    render(<ErrorState title="Figures are delayed" role="status" />);
    expect(screen.getByRole("status").textContent).toContain("Figures are delayed");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders an action slot", () => {
    render(<ErrorState title="Failed" action={<button type="button">Try again</button>} />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
