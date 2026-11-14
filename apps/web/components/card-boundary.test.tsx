// @vitest-environment jsdom
// T-245: on the client, one Finance card that throws shows "could not load" for that card only; the rest of the page renders.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FinanceView, type FinanceData } from "./finance-page";
import { data } from "./finance-page.fixtures";

afterEach(cleanup);

const card = (name: string) => screen.getByRole("heading", { name }).closest("[data-slot='kpi-card']") as HTMLElement;

describe("Finance card error boundary", () => {
  it("contains a failing card and logs only the card and the error name", () => {
    const d = data();
    const broken: FinanceData = {
      ...d,
      get pnl(): FinanceData["pnl"] {
        throw new TypeError("synthetic failure with a figure $999.99");
      },
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<FinanceView laneId="PKG" laneName="Pub K Group" period="mtd" data={broken} />);
      expect(card("Net income").textContent).toContain("Could not load. Reload in a minute.");
      expect(card("Cash").textContent).toContain("$2,001.00");
      expect(card("Bills due in 14 days").textContent).toContain("$410.50");
      expect(screen.getByTestId("finance-aging")).toBeTruthy();
      const ours = log.mock.calls.filter((c) => c[0] === "finance.card_failed");
      expect(ours).toEqual([["finance.card_failed", { card: "Net income", error: "TypeError" }]]);
    } finally {
      log.mockRestore();
    }
  });

  it("a card that failed recovers when the period link changes (the boundary is keyed on the period)", () => {
    const d = data();
    const broken: FinanceData = {
      ...d,
      get pnl(): FinanceData["pnl"] {
        throw new TypeError("synthetic failure");
      },
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const view = render(<FinanceView laneId="PKG" laneName="Pub K Group" period="mtd" data={broken} />);
      expect(card("Net income").textContent).toContain("Could not load");
      view.rerender(<FinanceView laneId="PKG" laneName="Pub K Group" period="ytd" data={data({}, "ytd")} />);
      expect(card("Net income").textContent).not.toContain("Could not load");
      expect(card("Net income").textContent).toContain("$600.00");
    } finally {
      log.mockRestore();
    }
  });
});
