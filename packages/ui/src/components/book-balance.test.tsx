import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BOOK_BALANCE_LABEL, BookBalance, BookBalanceLabel } from "./book-balance";

describe("BookBalanceLabel", () => {
  it("always reads 'Book balance'", () => {
    expect(BOOK_BALANCE_LABEL).toBe("Book balance");
    render(<BookBalanceLabel />);
    expect(screen.getByText("Book balance")).toBeTruthy();
  });

  it("never says bank balance", () => {
    const { container } = render(<BookBalanceLabel />);
    expect(container.textContent?.toLowerCase()).not.toContain("bank balance");
  });
});

describe("BookBalance", () => {
  it("labels the figure as a book balance with tabular numbers", () => {
    render(<BookBalance value="$12,345.67" accountName="Operating 1234" />);
    expect(screen.getByText("Book balance")).toBeTruthy();
    expect(screen.getByText("Operating 1234")).toBeTruthy();
    const figure = screen.getByText("$12,345.67");
    expect(figure.className).toContain("tabular-nums");
  });

  it("shows a negative book balance as given", () => {
    render(<BookBalance value="-$50.00" />);
    expect(screen.getByText("-$50.00")).toBeTruthy();
  });
});
