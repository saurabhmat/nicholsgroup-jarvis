// @vitest-environment jsdom
// T-230 B: Settings -> Connections as one compact list with the five columns, covering Google and Composio rows. Visibility
// is the loaders' job: a provider whose view is null is simply not drawn.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComposioSectionView } from "@/lib/composio-connection";
import type { GoogleSectionView } from "@/lib/google-connection";
import type { QuickBooksSectionView } from "@/lib/quickbooks-connection";
import { SUPPORT_EMAIL, SUPPORT_HREF } from "@/lib/support";
import { ConnectionsSection } from "./connections-section";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

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

  it("T-238 E: the failure banner sits at the top of Connections when given items, and is absent otherwise", () => {
    render(<ConnectionsSection laneId="PKG" google={google} quickbooks={null} composio={null} jobFailures={[{ functionId: "conn-sync.calendar", name: "Calendar sync", failures: 3, since: "2026-11-13T14:15:00Z", detail: null }]} now={new Date("2026-11-13T15:00:00Z")} />);
    expect(screen.getByTestId("job-failure-banner").textContent).toContain("Calendar sync has failed 3 times in a row since 9:15 AM ET.");
    expect(screen.getByTestId("job-failure-settings-link").getAttribute("href")).toBe("#connections");
    cleanup();
    render(<ConnectionsSection laneId="PKG" google={google} quickbooks={null} composio={null} />);
    expect(screen.queryByTestId("job-failure-banner")).toBeNull();
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

  it("Google needs reconnecting: an alert, and the row's own Reconnect bound to its connection (no section-level Reconnect Google)", () => {
    render(<ConnectionsSection laneId="PKG" google={{ connections: google.connections.map((c) => ({ ...c, state: "reconnect_required" as const })) }} quickbooks={null} composio={null} />);
    expect(screen.getByText("Google needs to be reconnected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect Google" })).toBeNull();
    const reconnect = screen.getByRole("button", { name: "Reconnect boss@example.test" });
    expect(reconnect.textContent).toBe("Reconnect");
    expect(reconnect.closest("form")?.getAttribute("action")).toBe(`/api/connect/google/start?lane=PKG&connection=${google.connections[0]?.id as string}`);
    expect(reconnect.closest("form")?.getAttribute("method")).toBe("post");
    expect(screen.getByRole("button", { name: "Connect another Google account" })).toBeTruthy();
  });

  it("every Google row has its own Reconnect; the connection id in each form is that row's", () => {
    const two = { connections: [google.connections[0] as GoogleSectionView["connections"][number], { ...(google.connections[0] as GoogleSectionView["connections"][number]), id: "00000000-0000-4000-8000-0000000000e2", mailbox: "ops@example.test", state: "disconnected" as const }] };
    render(<ConnectionsSection laneId="PKG" google={two} quickbooks={null} composio={null} />);
    const rows = screen.getAllByTestId("google-connection");
    expect(rows).toHaveLength(2);
    const forms = rows.map((r) => within(r).getByRole("button", { name: /^Reconnect / }).closest("form")?.getAttribute("action"));
    expect(forms).toEqual([`/api/connect/google/start?lane=PKG&connection=${two.connections[0]?.id as string}`, "/api/connect/google/start?lane=PKG&connection=00000000-0000-4000-8000-0000000000e2"]);
    expect(within(rows[1] as HTMLElement).getByText("Disconnected")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getAllByRole("button")).toHaveLength(1); // Reconnect only
    expect(within(rows[1] as HTMLElement).getAllByRole("button")).toHaveLength(2); // Reconnect + Connect another (last row only)
  });

  it("Sync now sits above the list for connected accounts, and not when nothing is connected or the status is unavailable", () => {
    render(<ConnectionsSection laneId="PKG" google={google} quickbooks={null} composio={null} />);
    expect(screen.getByTestId("settings-sync-now").tagName).toBe("BUTTON");
    cleanup();
    render(<ConnectionsSection laneId="PKG" google={{ connections: [] }} quickbooks={null} composio={null} />);
    expect(screen.queryByTestId("settings-sync-now")).toBeNull();
    cleanup();
    render(<ConnectionsSection laneId="PKG" google={{ connections: google.connections.map((c) => ({ ...c, state: "reconnect_required" as const })) }} quickbooks={null} composio={null} />);
    expect(screen.queryByTestId("settings-sync-now")).toBeNull();
  });

  it("unavailable status: says so and offers no connect button", () => {
    render(<ConnectionsSection laneId="PKG" google={{ connections: [], unavailable: true }} quickbooks={null} composio={null} />);
    expect(screen.getByText("Google connection status is unavailable")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("QuickBooks row (T-233, T-197)", () => {
  const qbo = (over: Partial<QuickBooksSectionView["connections"][number]> = {}): QuickBooksSectionView => ({
    connections: [
      {
        id: "q1", realmTail: "0001", state: "connected", lastSyncAt: "2026-11-10T15:00:00Z", classTracking: true, disconnect: { pendingId: null, gate: null },
        jobs: [{ job: "sync", at: "2026-11-10T15:00:00Z" }, { job: "reports", at: "2026-11-10T06:00:00Z" }, { job: "normalize", at: null }],
        ...over,
      },
    ],
  });

  it("connected: status, masked company id, last sync per job, Reconnect (form POST), Check connection and Disconnect", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo()} composio={null} />);
    const row = screen.getByTestId("quickbooks-connection");
    expect(within(row).getByText("Connected")).toBeTruthy();
    expect(within(row).getByText("Company ID ending 0001")).toBeTruthy();
    expect(within(row).getByText(/Books: Nov 10, 2026/)).toBeTruthy();
    expect(within(row).getByText(/Reports: Nov 10, 2026/)).toBeTruthy();
    expect(within(row).getByText("Finance data: not synced yet")).toBeTruthy();
    const reconnect = within(row).getByRole("button", { name: "Reconnect QuickBooks" });
    const form = reconnect.closest("form") as HTMLFormElement;
    expect(form.method).toBe("post");
    expect(form.getAttribute("action")).toBe("/api/connect/qbo/start?lane=PKG");
    expect(within(row).getByRole("button", { name: "Check connection" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Disconnect QuickBooks" })).toBeTruthy();
    expect(screen.queryByText(/Temporary/)).toBeNull();
  });

  it("not connected: Connect QuickBooks, no Check connection, no Disconnect", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={{ connections: [] }} composio={null} />);
    const row = screen.getByTestId("quickbooks-not-connected");
    expect(within(row).getAllByText("Not connected")).toHaveLength(2);
    expect(within(row).getByText("Not synced yet")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Connect QuickBooks" }).closest("form")?.getAttribute("action")).toBe("/api/connect/qbo/start?lane=PKG");
    expect(screen.queryByRole("button", { name: "Check connection" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Disconnect QuickBooks/ })).toBeNull();
  });

  it("disconnected: says so and offers Connect again", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={{ connections: [], wasDisconnected: true }} composio={null} />);
    const row = screen.getByTestId("quickbooks-not-connected");
    expect(within(row).getByText("Disconnected")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Connect QuickBooks" })).toBeTruthy();
  });

  it("connected but never synced says so, per job (the books fall back to the connection's own last sync time)", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo({ lastSyncAt: null, jobs: [{ job: "sync", at: null }, { job: "reports", at: null }, { job: "normalize", at: null }] })} composio={null} />);
    const row = screen.getByTestId("quickbooks-connection");
    expect(within(row).getByText("Books: not synced yet")).toBeTruthy();
    expect(within(row).getByText("Reports: not synced yet")).toBeTruthy();
  });

  it("connecting: no Check connection and no Disconnect yet", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo({ state: "connecting" })} composio={null} />);
    expect(within(screen.getByTestId("quickbooks-connection")).getByText("Connecting")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check connection" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Disconnect QuickBooks/ })).toBeNull();
  });

  it("degraded: the shared banner with Contact support, Check connection stays", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo({ state: "degraded" })} composio={null} />);
    expect(screen.getByText("QuickBooks is connected, with problems")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Contact support" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Check connection" })).toBeTruthy();
  });

  it("reconnect needed: the banner with Contact support (mailto), a Reconnect button, no Check connection; Disconnect stays available", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo({ state: "reconnect_required" })} composio={null} />);
    expect(screen.getByText("QuickBooks needs to be reconnected")).toBeTruthy();
    const banner = document.querySelector("[data-slot=error-banner]") as HTMLElement;
    expect(within(banner).getByRole("link", { name: "Contact support" }).getAttribute("href")).toMatch(new RegExp(`^${SUPPORT_HREF}`));
    expect(screen.getByRole("button", { name: "Reconnect QuickBooks" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check connection" })).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect QuickBooks" })).toBeTruthy();
  });

  it("unavailable status: the banner, and no connect button", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={{ connections: [], unavailable: true }} composio={null} />);
    expect(screen.getByText("QuickBooks connection status is unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect QuickBooks|Reconnect QuickBooks/ })).toBeNull();
  });

  it("class tracking on, off (with the unsplit warning) and not detected yet", () => {
    const { rerender } = render(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo({ classTracking: true })} composio={null} />);
    expect(screen.getByTestId("qbo-class-tracking").textContent).toBe("Class tracking: on");
    expect(screen.queryByTestId("qbo-class-tracking-warning")).toBeNull();
    rerender(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo({ classTracking: false })} composio={null} />);
    expect(screen.getByTestId("qbo-class-tracking").textContent).toContain("Class tracking: off");
    expect(screen.getByTestId("qbo-class-tracking-warning").textContent).toMatch(/unsplit/);
    rerender(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo({ classTracking: null })} composio={null} />);
    expect(screen.getByTestId("qbo-class-tracking").textContent).toBe("Class tracking: not checked yet");
    expect(screen.queryByTestId("qbo-class-tracking-warning")).toBeNull();
  });

  it("a pending disconnect replaces the button with a link to Approvals", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo({ disconnect: { pendingId: "a1", gate: { enabled: false, message: "Approving needs setup." } } })} composio={null} />);
    const pending = screen.getByTestId("qbo-disconnect-pending");
    expect(pending.textContent).toContain("Disconnect waiting for approval");
    expect(within(pending).getByRole("link", { name: "Open Approvals" }).getAttribute("href")).toBe("/PKG/approvals");
    expect(pending.textContent).toContain("Approving needs setup.");
    expect(screen.queryByRole("button", { name: "Disconnect QuickBooks" })).toBeNull();
  });

  it("shows the support link and the error-log download on the page itself", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo()} composio={null} now={new Date("2026-11-13T15:00:00Z")} />);
    expect(screen.getByRole("link", { name: "Contact support" }).getAttribute("href")).toBe(SUPPORT_HREF);
    expect(screen.getByTestId("qbo-error-export")).toBeTruthy();
  });

  it("never shows a token, a secret, the whole company id or a figure", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={qbo()} composio={null} />);
    const text = screen.getByTestId("connections-list").textContent ?? "";
    expect(text).not.toMatch(/token|secret|9130000000001/i);
    expect(text).not.toMatch(/[$]\s?\d|\d{1,3},\d{3}/);
  });
});

describe("QuickBooks rows: several connections and short ids (T-197 review)", () => {
  const base = { lastSyncAt: null, jobs: [] as never[], classTracking: true, disconnect: { pendingId: null, gate: null } };
  it("Reconnect sits on the row that needs it, not only on the last one", () => {
    render(
      <ConnectionsSection
        laneId="PKG"
        google={null}
        quickbooks={{ connections: [{ ...base, id: "a", realmTail: "1111", state: "reconnect_required" }, { ...base, id: "b", realmTail: "2222", state: "connected" }] }}
        composio={null}
      />,
    );
    const [first, second] = screen.getAllByTestId("quickbooks-connection");
    expect(within(first as HTMLElement).getByRole("button", { name: "Reconnect QuickBooks" })).toBeTruthy();
    expect(within(second as HTMLElement).queryByRole("button", { name: "Reconnect QuickBooks" })).toBeNull();
    expect(screen.getByText(/on the affected connection/)).toBeTruthy();
  });
  it("an id of 8 characters or fewer shows no tail", () => {
    render(<ConnectionsSection laneId="PKG" google={null} quickbooks={{ connections: [{ ...base, id: "a", realmTail: "", state: "connected" }] }} composio={null} />);
    expect(screen.getByText("Connected company")).toBeTruthy();
    expect(screen.queryByText(/ending/)).toBeNull();
  });
  it("the support address is the one constant", () => {
    expect(SUPPORT_EMAIL).toMatch(/@/);
  });
});
