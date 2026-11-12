// @vitest-environment jsdom
// T-234 part 2: the thread view Home's "Open" goes to (/[laneId]/inbox/[messageId]). "Open in Gmail" appears only with a usable
// link (authuser + hex thread id); the body is shown as plain text from the live read; a missing message is a 404.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ view: null as unknown }));
vi.mock("@/lib/lane-page", () => ({ loadLane: async () => ({ laneId: "PKG", name: "Pub K Group", lanes: [] }) }));
vi.mock("@/lib/guards", () => ({ guards: async () => ({}) }));
vi.mock("@/lib/timed", () => ({ timed: async <T,>(_n: string, f: () => Promise<T>) => f() }));
vi.mock("@/lib/inbox", async (orig) => ({ ...(await orig<typeof import("@/lib/inbox")>()), messageFor: async () => m.view }));
vi.mock("@nichols/connectors/google", () => ({ readGmailBody: async () => ({ text: "", truncated: false }) }));
const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }));
vi.mock("next/navigation", () => ({ notFound }));

import { MessagePage } from "./message-page";

afterEach(() => {
  cleanup();
  notFound.mockClear();
});
const meta = (over: Record<string, unknown> = {}) => ({ messageId: "m1", fromName: "Ann", fromAddress: "ann@acme.test", to: ["me@pubk.test"], cc: [], subject: "Capture plan", receivedAt: "2026-11-11T15:00:00Z", mailbox: "box@pubk.test", gmailUrl: "https://mail.google.com/mail/?authuser=box%40pubk.test#all/18c2f0a1b2c3d4e5", ...over });
const draw = async (id = "m1") => render((await MessagePage({ params: Promise.resolve({ laneId: "PKG", messageId: id }) })) as ReactNode & { type?: unknown } as never);

describe("MessagePage", () => {
  it("shows the headers, the live body as plain text and 'Open in Gmail' with the authuser link", async () => {
    m.view = { state: "ok", meta: meta(), text: "<b>Hello</b> body", truncated: false };
    await draw();
    expect(screen.getByRole("heading", { name: "Capture plan" })).toBeTruthy();
    expect(screen.getByTestId("message-body").textContent).toBe("<b>Hello</b> body"); // text, never HTML
    expect(screen.getByText("box@pubk.test", { selector: "dd" })).toBeTruthy();
    const gmail = screen.getByRole("link", { name: "Open in Gmail" });
    expect(gmail.getAttribute("href")).toBe("https://mail.google.com/mail/?authuser=box%40pubk.test#all/18c2f0a1b2c3d4e5");
    expect(gmail.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("no 'Open in Gmail' without a usable link; the message still shows", async () => {
    m.view = { state: "ok", meta: meta({ gmailUrl: null, mailbox: null }), text: "Body", truncated: false };
    await draw();
    expect(screen.queryByRole("link", { name: "Open in Gmail" })).toBeNull();
    expect(screen.getByTestId("message-body").textContent).toBe("Body");
  });

  it("an unreadable body keeps the header and says why", async () => {
    m.view = { state: "body_unavailable", meta: meta(), reason: "reconnect" };
    await draw();
    expect(screen.getByText("The message text could not be loaded")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in Gmail" })).toBeTruthy();
  });

  it("an unknown or invisible message is a 404, and a malformed escape is too", async () => {
    m.view = { state: "not_found" };
    await expect(draw()).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(draw("%E0%A4%A")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(2);
  });
});
