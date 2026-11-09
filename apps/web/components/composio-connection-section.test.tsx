// @vitest-environment jsdom
// T-219: the Composio section as the owner sees it: "Not configured" does nothing, Connect is a same-origin form POST
// to the start route, Test appears only for a connected account, Disconnect is disabled with the Approvals note.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComposioSectionView } from "@/lib/composio-connection";
import { ComposioConnectionSection } from "./composio-connection-section";

afterEach(cleanup);

const view = (over: Partial<ComposioSectionView> = {}, gmail: ComposioSectionView["toolkits"][number]["connection"] = null, configured = true): ComposioSectionView => ({
  toolkits: [
    { toolkit: "gmail", label: "Gmail", configured, ...(configured ? {} : { missing: ["COMPOSIO_GMAIL_AUTH_CONFIG_ID"] }), connection: gmail },
    { toolkit: "googlecalendar", label: "Google Calendar", configured, ...(configured ? {} : { missing: ["COMPOSIO_API_KEY", "COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID"] }), connection: null },
  ],
  ...over,
});

describe("ComposioConnectionSection", () => {
  it("not configured: the button names the missing settings (names only), is disabled and is not a form", () => {
    render(<ComposioConnectionSection laneId="PKG" view={view({}, null, false)} />);
    const gmail = within(screen.getByTestId("composio-gmail"));
    const button = gmail.getByRole("button", { name: "Not configured: COMPOSIO_GMAIL_AUTH_CONFIG_ID is not set" }) as HTMLButtonElement;
    const calendar = within(screen.getByTestId("composio-googlecalendar")).getByRole("button", { name: "Not configured: COMPOSIO_API_KEY, COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID are not set" });
    // H-042: the long setting names wrap inside the button instead of widening the page at phone width.
    for (const cls of ["[overflow-wrap:anywhere]", "whitespace-normal", "max-w-full", "min-w-0", "shrink"]) expect(calendar.className.split(/\s+/)).toContain(cls);
    for (const cls of ["shrink-0", "whitespace-nowrap"]) expect(calendar.className.split(/\s+/)).not.toContain(cls); // merged away
    expect(button.disabled).toBe(true);
    expect(button.closest("form")).toBeNull();
    expect(gmail.queryByRole("button", { name: "Connect via Composio" })).toBeNull();
  });

  it("configured: Connect via Composio is a POST form to the start route for the lane and toolkit", () => {
    render(<ComposioConnectionSection laneId="PKG" view={view()} />);
    const button = within(screen.getByTestId("composio-gmail")).getByRole("button", { name: "Connect via Composio" });
    const form = button.closest("form") as HTMLFormElement;
    expect(form.method).toBe("post");
    expect(form.getAttribute("action")).toBe("/api/connect/composio/start?lane=PKG&toolkit=gmail");
    expect(within(screen.getByTestId("composio-googlecalendar")).getByRole("button", { name: "Connect via Composio" }).closest("form")?.getAttribute("action")).toBe("/api/connect/composio/start?lane=PKG&toolkit=googlecalendar");
  });

  it("connected: shows the address, status, last sync, a Test button and a disabled Disconnect that says it arrives with Approvals", () => {
    const c = { id: "c1", state: "connected" as const, address: "boss@example.test", mailboxAllowed: true, lastSyncAt: null };
    render(<ComposioConnectionSection laneId="PKG" view={view({}, c)} />);
    const gmail = within(screen.getByTestId("composio-gmail"));
    expect(gmail.getByText("boss@example.test")).toBeTruthy();
    expect(gmail.getByText("Connected")).toBeTruthy();
    expect(gmail.getByText("not synced yet")).toBeTruthy();
    expect(gmail.getByRole("button", { name: "Test" })).toBeTruthy();
    const disconnect = gmail.getByRole("button", { name: "Disconnect" }) as HTMLButtonElement;
    expect(disconnect.disabled).toBe(true);
    expect(disconnect.title).toBe("Disconnect arrives with Approvals");
    expect(disconnect.closest("form")).toBeNull();
    expect(gmail.getByRole("button", { name: "Replace account via Composio" })).toBeTruthy();
    expect(gmail.getByText(/previous account stays in Composio until it is removed by hand/)).toBeTruthy();
    expect(screen.getByText(/Disconnect arrives with Approvals: removing/)).toBeTruthy();
    expect(screen.getByText(/Composio dashboard/)).toBeTruthy();
  });

  it("reconnect needed: an alert and Reconnect via Composio", () => {
    const c = { id: "c1", state: "reconnect_required" as const, address: "boss@example.test", mailboxAllowed: true, lastSyncAt: null };
    render(<ComposioConnectionSection laneId="PKG" view={view({}, c)} />);
    const gmail = within(screen.getByTestId("composio-gmail"));
    expect(gmail.getByText("Gmail needs to be reconnected")).toBeTruthy();
    expect(gmail.getByRole("button", { name: "Reconnect via Composio" })).toBeTruthy();
  });

  it("an address outside the mailbox list gets a note; a connecting row has no Test button", () => {
    const out = { id: "c1", state: "connected" as const, address: "x@example.test", mailboxAllowed: false, lastSyncAt: null };
    render(<ComposioConnectionSection laneId="PKG" view={view({}, out)} />);
    expect(screen.getByText(/not in the company's mailbox list/)).toBeTruthy();
    cleanup();
    const pending = { id: "c2", state: "connecting" as const, address: null, mailboxAllowed: false, lastSyncAt: null };
    render(<ComposioConnectionSection laneId="PKG" view={view({}, pending)} />);
    expect(within(screen.getByTestId("composio-gmail")).queryByRole("button", { name: "Test" })).toBeNull();
  });

  it("unavailable: says so and offers no buttons", () => {
    render(<ComposioConnectionSection laneId="PKG" view={view({ unavailable: true })} />);
    expect(screen.getByText("Composio connection status is unavailable")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("the page never promises a disconnect it cannot do", () => {
    render(<ComposioConnectionSection laneId="PKG" view={view()} />);
    expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull(); // nothing to disconnect when not connected
  });
});
