import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FreshnessBadge, SourceChip } from "./source-chip";

describe("SourceChip", () => {
  it("shows the source, freshness and as-of display string", () => {
    render(<SourceChip source="QuickBooks" freshness="live" asOf="Oct 27, 2026, 5:00 PM ET" />);
    const chip = screen.getByText("QuickBooks").closest("[data-slot=source-chip]");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("Live");
    expect(chip?.textContent).toContain("as of Oct 27, 2026, 5:00 PM ET");
    expect(chip?.getAttribute("data-freshness")).toBe("live");
  });

  it("renders a machine-readable time when an ISO timestamp is given", () => {
    render(
      <SourceChip
        source="Stripe"
        freshness="cached"
        asOf="Oct 27, 2026"
        asOfDateTime="2026-10-27T21:00:00Z"
      />,
    );
    const time = screen.getByText("Oct 27, 2026");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("datetime")).toBe("2026-10-27T21:00:00Z");
  });

  it("uses plain text for as-of when no ISO timestamp is given", () => {
    render(<SourceChip source="Stripe" freshness="cached" asOf="Oct 27, 2026" />);
    expect(screen.getByText("Oct 27, 2026").tagName).not.toBe("TIME");
  });

  it("marks stale data in text, not only colour", () => {
    render(<SourceChip source="GoHighLevel" freshness="stale" asOf="Oct 20, 2026" />);
    expect(screen.getByText("Stale")).toBeTruthy();
  });
});

describe("FreshnessBadge", () => {
  it.each([
    ["live", "Live"],
    ["cached", "Cached"],
    ["stale", "Stale"],
  ] as const)("labels %s as %s", (freshness, label) => {
    render(<FreshnessBadge freshness={freshness} />);
    const badge = screen.getByText(label);
    expect(badge.getAttribute("data-freshness")).toBe(freshness);
  });
});
