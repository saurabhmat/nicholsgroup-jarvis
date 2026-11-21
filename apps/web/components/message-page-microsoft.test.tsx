// @vitest-environment jsdom
// T-260: the message page for a Microsoft row. The body is read through the facade with the signed-in user's id (the owner check) and the row's own connection;
// texts name the row's provider ("Outlook", "Microsoft"); a Google row keeps its wording (message-page.test.tsx, unchanged).
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const USER = "00000000-0000-4000-8000-0000000000a1";
const m = vi.hoisted(() => ({ view: null as unknown, captured: null as null | ((l: string, c: string, msg: string) => Promise<unknown>), facade: vi.fn(async () => ({ text: "Synthetic body", truncated: false })) }));
vi.mock("@/lib/lane-page", () => ({ loadLane: async () => ({ laneId: "PKG", name: "Pub K Group", lanes: [] }) }));
vi.mock("@/lib/guards", () => ({ guards: async () => ({ requireLane: async () => ({ session: { userId: USER } }) }) }));
vi.mock("@/lib/timed", () => ({ timed: async <T,>(_n: string, f: () => Promise<T>) => f() }));
vi.mock("@/lib/inbox", async (orig) => ({ ...(await orig<typeof import("@/lib/inbox")>()), messageFor: async (_g: unknown, _l: string, _id: string, read: (l: string, c: string, msg: string) => Promise<unknown>) => ((m.captured = read), m.view) }));
vi.mock("@nichols/connectors/facade", () => ({ readBody: m.facade }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));

import { MessagePage } from "./message-page";

afterEach(() => {
  cleanup();
  m.facade.mockClear();
});
const OUTLOOK = "https://outlook.office365.com/owa/?ItemID=ms-1&exvsurl=1&viewmodel=ReadMessageItem";
const meta = (over: Record<string, unknown> = {}) => ({ messageId: "m1", fromName: "Ann", fromAddress: "ann@acme.example.test", to: ["robert@pubkgroup.example.test"], cc: [], subject: "Capture plan", receivedAt: "2026-11-20T15:00:00Z", mailbox: "robert@pubkgroup.example.test", gmailUrl: null, provider: "microsoft", openUrl: OUTLOOK, openLabel: "Open in Outlook", ...over });
const draw = async () => render((await MessagePage({ params: Promise.resolve({ laneId: "PKG", messageId: "m1" }) })) as ReactNode & { type?: unknown } as never);

describe("MessagePage for a Microsoft row", () => {
  it("reads the body through the facade with the signed-in user's id, for the row's own connection", async () => {
    m.view = { state: "ok", meta: meta(), text: "Synthetic body", truncated: false };
    await draw();
    await m.captured?.("PKG", "conn-ms", "AAkALg=");
    expect(m.facade).toHaveBeenCalledWith("PKG", "conn-ms", "AAkALg=", USER);
  });

  it("shows 'Open in Outlook' from the row's link and the mailbox with its provider, and no Gmail wording", async () => {
    m.view = { state: "ok", meta: meta(), text: "Synthetic body", truncated: true };
    await draw();
    const link = screen.getByRole("link", { name: "Open in Outlook" });
    expect(link.getAttribute("href")).toBe(OUTLOOK);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("Outlook · robert@pubkgroup.example.test", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText(/open it in Outlook to read the rest/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Gmail|Google/);
  });

  it("an unreadable body names Microsoft and Outlook, never Google or Gmail; no link means none shown", async () => {
    m.view = { state: "body_unavailable", meta: meta({ openUrl: null }), reason: "reconnect" };
    await draw();
    expect(screen.getByText("Microsoft needs to be reconnected in Settings → Connections.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open in/ })).toBeNull();
    cleanup();
    m.view = { state: "body_unavailable", meta: meta(), reason: "gone" };
    await draw();
    expect(screen.getByText("This message is no longer in Outlook")).toBeTruthy();
    cleanup();
    m.view = { state: "body_unavailable", meta: meta(), reason: "error" };
    await draw();
    expect(screen.getByText("Try again in a minute, or open it in Outlook.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Gmail|Google/);
  });
});
