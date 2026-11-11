// @vitest-environment jsdom
// T-230 B: Settings -> Connections as one compact list with the five columns, covering Google and Composio rows. Visibility
// is the loaders' job: a provider whose view is null is simply not drawn.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComposioSectionView } from "@/lib/composio-connection";
import type { GoogleSectionView } from "@/lib/google-connection";
import type { QuickBooksSectionView } from "@/lib/quickbooks-connection";
import { ConnectionsSection } from "./connections-section";

afterEach(cleanup);

const google: GoogleSectionView = {
  connections: [{ id: "g1", mailbox: "boss@example.test", state: "connected", mailboxAllowed: true, lastMailSyncAt: "2026-11-09T14:00:00Z", lastCalendarSyncAt: null }],
};
const keyless: ComposioSectionView = {
  toolkits: [
    { toolkit: "gmail", label: "Gmail", configured: false, missing: ["COMPOSIO_API_KEY"], connection: null },
    { toolkit: "googlecalendar", label: "Google Calendar", configured: false, missing: ["COMPOSIO_API_KEY"], connection: null },
  ],
};

describe("ConnectionsSection", () => {
  it("one region with a header line (provider, account, status, last sync, actions) and a row for Google", () => {
    render(<ConnectionsSection laneId="PKG" google={google} quickbooks={null} composio={null} />);
    const region = screen.getByRole("region", { name: "Connections" });
    expect(region.id).toBe("connections");
    const list = within(region).getByTestId("connections-list");
    expect(list.textContent).toContain("ProviderAccountStatusLast syncActions");
    const row = within(list).getByTestId("google-connection");
    expect(row.textContent).toContain("boss@example.test");
    expect(within(row).getByText("Connected")).toBeTruthy();
    expect(within(row).getByText(/Mail: Nov 9, 2026/)).toBeTruthy();
    expect(within(row).getByText("Calendar: not synced yet")).toBeTruthy();
    const connect = within(row).getByRole("button", { name: "Connect another Google account" });
    expect(connect.closest("form")?.getAttribute("action")).toBe("/api/connect/google/start?lane=PKG");
    expect(screen.queryByTestId("composio-gmail")).toBeNull(); // Composio view is null: not drawn
  });

  it("Google not connected: one row with Connect Google", () => {
    render(<ConnectionsSection laneId="PKG" google={{ connections: [] }} quickbooks={null} composio={null} />);
    const row = screen.getByTestId("google-not-connected");
    expect(within(row).getAllByText("Not connected")).toHaveLength(2); // the account cell and the status chip
    expect(within(row).getByRole("button", { name: "Connect Google" })).toBeTruthy();
  });

  it("Google and Composio share one list; with no Composio key the Composio part is a single line of setting NAMES", () => {
    render(<ConnectionsSection laneId="PKG" google={google} quickbooks={null} composio={keyless} />);
    const list = screen.getByTestId("connections-list");
    expect(within(list).getByTestId("google-connection")).toBeTruthy();
    expect(within(list).getByText("Composio not configured on this server (COMPOSIO_API_KEY not set)")).toBeTruthy();
    expect(within(list).queryByTestId("composio-gmail")).toBeNull();
    expect(list.textContent).not.toMatch(/=|sk_|secret/i);
  });

  it("Composio only (no Google view): no Google row", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={null} composio={keyless} />);
    expect(screen.queryByTestId("google-connection")).toBeNull();
    expect(screen.queryByTestId("google-not-connected")).toBeNull();
  });

  it("Google needs reconnecting: an alert and Reconnect Google", () => {
    render(<ConnectionsSection laneId="PKG" google={{ connections: google.connections.map((c) => ({ ...c, state: "reconnect_required" as const })) }} quickbooks={null} composio={null} />);
    expect(screen.getByText("Google needs to be reconnected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect Google" })).toBeTruthy();
  });

  it("unavailable status: says so and offers no connect button", () => {
    render(<ConnectionsSection laneId="PKG" google={{ connections: [], unavailable: true }} quickbooks={null} composio={null} />);
    expect(screen.getByText("Google connection status is unavailable")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("QuickBooks row (T-233)", () => {
  const qbo = (over: Partial<QuickBooksSectionView["connections"][number]> = {}): QuickBooksSectionView => ({
    connections: [{ id: "q1", realmId: "9130000000001", state: "connected", lastSyncAt: "2026-11-10T15:00:00Z", ...over }],
  });

  it("connected: status, company id, last sync, Reconnect QuickBooks (form POST to the start route) and Check connection", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo()} composio={null} />);
    const row = screen.getByTestId("quickbooks-connection");
    expect(row.textContent).toContain("QuickBooks");
    expect(within(row).getByText("Connected")).toBeTruthy();
    expect(within(row).getByText("Company ID 9130000000001")).toBeTruthy();
    expect(within(row).getByText(/Nov 10, 2026/)).toBeTruthy();
    const reconnect = within(row).getByRole("button", { name: "Reconnect QuickBooks" });
    const form = reconnect.closest("form") as HTMLFormElement;
    expect(form.method).toBe("post");
    expect(form.getAttribute("action")).toBe("/api/connect/qbo/start?lane=PKG");
    expect(within(row).getByRole("button", { name: "Check connection" })).toBeTruthy();
    expect(screen.queryByText(/Temporary/)).toBeNull();
  });

  it("not connected: Connect QuickBooks, no Check connection", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={{ connections: [] }} composio={null} />);
    const row = screen.getByTestId("quickbooks-not-connected");
    expect(within(row).getAllByText("Not connected")).toHaveLength(2);
    expect(within(row).getByText("Not synced yet")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Connect QuickBooks" }).closest("form")?.getAttribute("action")).toBe("/api/connect/qbo/start?lane=PKG");
    expect(screen.queryByRole("button", { name: "Check connection" })).toBeNull();
  });

  it("connected but never synced says so", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo({ lastSyncAt: null })} composio={null} />);
    expect(within(screen.getByTestId("quickbooks-connection")).getByText("not synced yet")).toBeTruthy();
  });

  it("reconnect needed: an alert, a Reconnect button and no Check connection", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo({ state: "reconnect_required" })} composio={null} />);
    expect(screen.getByText("QuickBooks needs to be reconnected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect QuickBooks" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check connection" })).toBeNull();
  });

  it("unavailable status: says so and offers no connect button", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={{ connections: [], unavailable: true }} composio={null} />);
    expect(screen.getByText("QuickBooks connection status is unavailable")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never shows a token or secret, and has no disconnect control", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo()} composio={null} />);
    const text = screen.getByTestId("connections-list").textContent ?? "";
    expect(text).not.toMatch(/token|secret|disconnect|revoke/i);
  });
});
