// @vitest-environment jsdom
// T-220: "import my memories" in the assistant chat is answered with a link to the import page, with no model call and no request.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssistantChat } from "./assistant-chat";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("assistant chat: import request", () => {
  it("answers with a link to Import memories and sends nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    render(<AssistantChat laneId="PKG" sources={[]} brainSetup />);
    fireEvent.change(screen.getByLabelText("Ask the assistant"), { target: { value: "Import my memories" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const link = await screen.findByRole("link", { name: "Import memories" });
    expect(link.getAttribute("href")).toBe("/PKG/onboarding/import");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("without the brain view the phrase is an ordinary question for the model (the page itself is gated)", async () => {
    const fetchSpy = vi.fn(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchSpy);
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    render(<AssistantChat laneId="PKG" sources={[]} />);
    fireEvent.change(screen.getByLabelText("Ask the assistant"), { target: { value: "Import my memories" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await screen.findByText(/not set up|went wrong|not available/);
    expect(screen.queryByRole("link", { name: "Import memories" })).toBeNull();
  });
});
