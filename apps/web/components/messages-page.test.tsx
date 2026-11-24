// @vitest-environment jsdom
// T-280: the Messages page for every state, drawn at desktop and iPhone width (jsdom does not evaluate CSS; the width is set so a component that branched on it would show, and the
// markup is checked to be the same single column of fixed text and plain forms that works at both). Mocks only; nothing from Microsoft.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MessagesScreen } from "./messages-page";
import type { MessagesState } from "@/lib/teams-messages";

afterEach(cleanup);
const ID = "00000000-0000-4000-8000-0000000000c1";
const ACCOUNT = "me@teams.example.test";
const connected = (over: Partial<Extract<MessagesState, { kind: "connected" }>> = {}): MessagesState => ({ kind: "connected", connectionId: ID, account: ACCOUNT, degraded: false, missing: [], adminConsent: false, laneFeatures: ["chat_read", "call_links"], accounts: [{ connectionId: CONN, account: "me@teams.example.test", label: "teams.example.test", usable: true, degraded: false, missing: [], has: ["chat_read", "call_links"] }], multi: false, canAddAnother: false, ...over });

const WIDTHS = [1280, 390];
const at = (width: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
};

describe.each(WIDTHS)("Messages at %ipx", (width) => {
  const draw = (state: MessagesState, workspace?: ReactNode) => {
    at(width);
    return render(<MessagesScreen laneId="PKG" state={state} {...(workspace ? { workspace } : {})} />);
  };

  it("Teams not set up for the company (or no access): a fixed line and no button", () => {
    for (const kind of ["not_enabled", "no_access"] as const) {
      draw({ kind });
      expect(screen.getByText("Teams is not set up for this company.")).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
      cleanup();
    }
  });

  it("not connected: Sign in to Teams posts to the Teams start route of this lane", () => {
    draw({ kind: "not_connected" });
    const box = screen.getByTestId("messages-not-connected");
    const form = within(box).getByRole("button", { name: "Sign in to Teams" }).closest("form");
    expect(form?.getAttribute("action")).toBe("/api/connect/teams/start?lane=PKG");
    expect(form?.getAttribute("method")).toMatch(/post/i);
    expect(box.textContent).toContain("It is not your portal sign-in");
    expect(box.textContent).toContain("stores no message text");
  });

  it("needs reconnect: Reconnect Teams names the connection", () => {
    draw({ kind: "reconnect", connectionId: ID, account: ACCOUNT, accounts: [{ connectionId: ID, account: ACCOUNT, label: "teams.example.test", usable: false, degraded: false, missing: [], has: [] }] });
    const form = within(screen.getByTestId("messages-reconnect")).getByRole("button", { name: "Reconnect Teams" }).closest("form");
    expect(form?.getAttribute("action")).toBe(`/api/connect/teams/start?lane=PKG&connection=${ID}`);
    expect(screen.getByText("Your Teams sign-in expired")).toBeTruthy();
  });

  it("connected: 'Connected as <UPN>' and the chats slot (the chat list and conversation stream into it, T-283); no sample data, no placeholder list", () => {
    draw(connected(), <p data-testid="workspace-slot">chats go here</p>);
    expect(screen.getByText(`Connected as ${ACCOUNT}`)).toBeTruthy();
    expect(screen.getByTestId("workspace-slot")).toBeTruthy();
    expect(screen.queryByTestId("messages-feature-missing")).toBeNull();
    expect(screen.queryByTestId("messages-degraded")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText("Chats arrive in the next update")).toBeNull();
  });

  it("connected without a slot (no chats to draw): the card alone, nothing invented", () => {
    draw(connected());
    expect(screen.getByText(`Connected as ${ACCOUNT}`)).toBeTruthy();
    expect(screen.queryByTestId("workspace-slot")).toBeNull();
  });

  it("a feature missing on the connection: the fixed 'Reconnect Teams to add …' text with the button; what exists keeps working", () => {
    draw(connected({ missing: ["chat_send", "channels_read"] }));
    const note = screen.getByTestId("messages-feature-missing");
    expect(note.textContent).toContain("Reconnect Teams to add sending and channels. What you already have keeps working.");
    expect(within(note).getByRole("button", { name: "Reconnect Teams" }).closest("form")?.getAttribute("action")).toBe(`/api/connect/teams/start?lane=PKG&connection=${ID}`);
    expect(note.textContent).not.toContain("Microsoft admin");
  });

  it("channels that need an administrator: the admin approval text (no link)", () => {
    draw(connected({ missing: ["channels_read"], adminConsent: true }));
    const note = screen.getByTestId("messages-feature-missing");
    expect(note.textContent).toContain("Your organisation's Microsoft admin must approve the portal's Teams app once");
    expect(note.querySelector("a")).toBeNull();
  });

  it("paused: 'Teams is paused for this company.'", () => {
    draw({ kind: "paused" });
    expect(screen.getByText("Teams is paused for this company.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("C5: a company on a cloud this build does not serve says so, not 'paused'", () => {
    draw({ kind: "paused", unsupportedCloud: true });
    expect(screen.getByText("Teams is not available yet on this company's Microsoft cloud.")).toBeTruthy();
    expect(screen.queryByText("Teams is paused for this company.")).toBeNull();
  });

  it("degraded: a notice, still connected", () => {
    draw(connected({ degraded: true }));
    expect(screen.getByTestId("messages-degraded")).toBeTruthy();
    expect(screen.getByText(`Connected as ${ACCOUNT}`)).toBeTruthy();
  });

  it("unavailable: an error line, never an empty list or a Sign in button", () => {
    draw({ kind: "unavailable" });
    expect(screen.getByTestId("messages-unavailable").textContent).toContain("Teams could not be reached");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("an address with markup is drawn as text (rule 9)", () => {
    draw(connected({ account: "<img src=x onerror=alert(1)>@teams.example.test" }));
    expect(document.querySelector("img")).toBeNull();
  });
});
