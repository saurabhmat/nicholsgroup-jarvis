// @vitest-environment jsdom
// H-042 fix: with no chat model configured, the Assistant page still offers the bank-driven setup interview behind the
// same "Set up my brain" entry the chat shows; nothing opens until the user asks.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/brain-interview", () => ({
  BrainInterview: (p: { laneId: string; mode: string; startAt?: string }) => (
    <div data-testid="brain-interview" data-lane={p.laneId} data-mode={p.mode} data-start={p.startAt} />
  ),
}));

import { BrainSetupEntry } from "./brain-setup-entry";

afterEach(cleanup);

describe("BrainSetupEntry", () => {
  it("shows both entry buttons and no interview until one is clicked", () => {
    render(<BrainSetupEntry laneId="PKG" />);
    expect(screen.getByRole("button", { name: "Set up my brain" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up my Personal Assistant" })).toBeTruthy();
    expect(screen.queryByTestId("brain-interview")).toBeNull();
  });

  it("opens the chat-mode interview at the chosen start, and Close hides it", () => {
    render(<BrainSetupEntry laneId="PKG" />);
    fireEvent.click(screen.getByRole("button", { name: "Set up my brain" }));
    const flow = screen.getByTestId("brain-interview");
    expect(flow.dataset.lane).toBe("PKG");
    expect(flow.dataset.mode).toBe("chat");
    expect(flow.dataset.start).toBe("setup");
    fireEvent.click(screen.getByRole("button", { name: "Set up my Personal Assistant" }));
    expect(screen.getByTestId("brain-interview").dataset.start).toBe("assistant");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("brain-interview")).toBeNull();
  });
});
