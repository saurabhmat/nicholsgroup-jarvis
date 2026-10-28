import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { KpiCard } from "./kpi-card";

describe("KpiCard", () => {
  it("renders the label and pre-formatted value with tabular numbers", () => {
    render(<KpiCard label="AR over 30 days" value="$4,210.00" />);
    expect(screen.getByRole("heading", { name: "AR over 30 days" })).toBeTruthy();
    const value = screen.getByText("$4,210.00");
    expect(value.className).toContain("tabular-nums");
  });

  it("renders one source chip per source", () => {
    render(
      <KpiCard
        label="MRR"
        value="$9,800.00"
        sources={[
          { source: "Stripe", freshness: "live", asOf: "Oct 28, 2026" },
          { source: "QuickBooks", freshness: "stale", asOf: "Oct 20, 2026" },
        ]}
      />,
    );
    expect(screen.getByText("Stripe")).toBeTruthy();
    expect(screen.getByText("QuickBooks")).toBeTruthy();
    expect(screen.getByText("Stale")).toBeTruthy();
  });

  it("shows the Book balance label for cash cards", () => {
    render(<KpiCard label="Cash — Operating" value="$1,000.00" bookBalance />);
    expect(screen.getByText("Book balance")).toBeTruthy();
  });

  it("shows a qualifier such as month to date", () => {
    render(<KpiCard label="Revenue" value="$500.00" qualifier="month to date" />);
    expect(screen.getByText("month to date")).toBeTruthy();
  });

  it("shows the pending-definition text instead of a figure", () => {
    render(
      <KpiCard
        label="Customer churn"
        value="0.00%"
        status="pending_definition"
        statusText="Pending definition (D-3)"
      />,
    );
    expect(screen.getByText("Pending definition (D-3)")).toBeTruthy();
    expect(screen.queryByText("0.00%")).toBeNull();
  });

  it("has a default text for pending definition and no data", () => {
    const { rerender } = render(<KpiCard label="Churn" status="pending_definition" />);
    expect(screen.getByText("Pending definition")).toBeTruthy();
    rerender(<KpiCard label="Churn" status="no_data" />);
    expect(screen.getByText("No data yet")).toBeTruthy();
  });

  it("falls back to no-data text when status is ok but the value is missing", () => {
    render(<KpiCard label="AP due in 14 days" />);
    expect(screen.getByText("No data yet")).toBeTruthy();
  });

  it("treats an empty value as no data", () => {
    render(<KpiCard label="AR total" value="" />);
    expect(screen.getByText("No data yet")).toBeTruthy();
    expect(document.querySelector("[data-slot=kpi-value]")).toBeNull();
  });

  it("keeps the Book balance label while a cash card is pending definition", () => {
    render(<KpiCard label="Cash" value="$1.00" bookBalance status="pending_definition" />);
    expect(screen.getByText("Book balance")).toBeTruthy();
    expect(screen.getByText("Pending definition")).toBeTruthy();
    expect(screen.queryByText("$1.00")).toBeNull();
  });

  it("supports a different heading level", () => {
    render(<KpiCard label="MRR" value="$1.00" headingLevel="h2" />);
    expect(screen.getByRole("heading", { level: 2, name: "MRR" })).toBeTruthy();
  });

  it("renders values as text, not HTML", () => {
    const { container } = render(<KpiCard label="<b>x</b>" value="<img src=x onerror=alert(1)>" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });
});
