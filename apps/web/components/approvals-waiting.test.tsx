// @vitest-environment jsdom
// T-237 part C: the approvals banner: "N approvals waiting", hidden at 0, a Review link.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/approvals", () => ({ waitingCount: async () => m.n }));
vi.mock("@/lib/guards", () => ({ guards: async () => ({}) }));
import { ApprovalsWaiting } from "./approvals-waiting";

afterEach(cleanup);
const draw = async () => render(<>{await ApprovalsWaiting({ laneId: "PKG" })}</>);

describe("ApprovalsWaiting", () => {
  it("is hidden at 0", async () => {
    m.n = 0;
    const { container } = await draw();
    expect(container.firstChild).toBeNull();
  });
  it.each([[1, "1 approval waiting"], [2, "2 approvals waiting"]])("%i -> %s, with a Review link to Approvals", async (n, text) => {
    m.n = n;
    await draw();
    expect(screen.getByTestId("approvals-waiting-text").textContent).toBe(text);
    expect(screen.getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/PKG/approvals");
  });
});
