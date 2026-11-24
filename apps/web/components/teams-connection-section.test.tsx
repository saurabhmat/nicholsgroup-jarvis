// @vitest-environment jsdom
// T-280: "Your Teams account" on Settings -> Connections next to the Google and Microsoft sections (unchanged): Sign in / Reconnect / Disconnect on your own row, other people's rows as
// health only, paused rows, the reconnect-to-add note, the admin approval text, fixed wording. Mocks only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
// the live-updates line has its own test (teams-live-status.test.tsx) and asks the portal's database after mount: stubbed here so the "nothing is requested before the person confirms" assertions stay exact
vi.mock("./teams-live-status", () => ({ TeamsLiveStatus: ({ children }: { children: string }) => children }));

import { ConnectionsSection } from "./connections-section";
import type { GoogleSectionView } from "@/lib/google-connection";
import type { MicrosoftSectionView } from "@/lib/microsoft-connection";
import type { TeamsConnectionView, TeamsSectionView } from "@/lib/teams-connection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  nav.replace.mockClear();
  nav.refresh.mockClear();
});

const ID = "00000000-0000-4000-8000-0000000000c2";
const conn = (over: Partial<TeamsConnectionView> = {}): TeamsConnectionView => ({ id: ID, account: "me@teams.example.test", state: "connected", mine: true, has: ["chat_read", "call_links"], ...over });
const teams = (over: Partial<TeamsSectionView> = {}): TeamsSectionView => ({ connections: [conn()], laneFeatures: ["chat_read", "call_links"], maxAccounts: 1, needsAdminConsent: false, ...over });
const google = (): GoogleSectionView => ({ connections: [{ id: "00000000-0000-4000-8000-0000000000c1", mailbox: "me@mail.example.test", state: "connected", mailboxAllowed: true, mine: true, lastMailSyncAt: null, lastCalendarSyncAt: null }] });
const draw = (t: TeamsSectionView | null, g: GoogleSectionView | null = null, m: MicrosoftSectionView | null = null) => render(<ConnectionsSection laneId="PKG" google={g} microsoft={m} teams={t} quickbooks={null} composio={null} />);

describe("Your Teams account", () => {
  it("a connected row: the sign-in name, status, features, Reconnect and Disconnect; no Sign in button beside an active account", () => {
    draw(teams());
    const row = screen.getByTestId("teams-connection");
    expect(within(row).getByText("Your Teams account")).toBeTruthy();
    expect(within(row).getByText("me@teams.example.test")).toBeTruthy();
    expect(within(row).getByText("Connected")).toBeTruthy();
    expect(row.textContent).toContain("Has: chat read, call links");
    expect(within(row).getByRole("button", { name: "Reconnect me@teams.example.test" }).closest("form")?.getAttribute("action")).toBe(`/api/connect/teams/start?lane=PKG&connection=${ID}`);
    expect(within(row).getByRole("button", { name: "Disconnect me@teams.example.test" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in to Teams" })).toBeNull();
  });

  it("not connected: Sign in to Teams posts to the Teams start route", () => {
    draw(teams({ connections: [] }));
    const form = screen.getByRole("button", { name: "Sign in to Teams" }).closest("form");
    expect(form?.getAttribute("action")).toBe("/api/connect/teams/start?lane=PKG");
    expect(form?.getAttribute("method")).toMatch(/post/i);
  });

  it("a reconnect-needed row gets a notice and a primary Reconnect", () => {
    draw(teams({ connections: [conn({ state: "reconnect_required" })] }));
    expect(screen.getByTestId("teams-reconnect-notice").textContent).toContain("Teams needs to be reconnected");
    expect(screen.getByText("Reconnect needed")).toBeTruthy();
  });

  it("a feature the company lists but the connection lacks: the fixed 'Reconnect Teams to add' note", () => {
    draw(teams({ laneFeatures: ["chat_read", "call_links", "channels_read"], needsAdminConsent: true }));
    expect(screen.getByTestId("teams-feature-note").textContent).toBe("Reconnect Teams to add channels. What you already have keeps working.");
    expect(screen.getByTestId("teams-admin-consent").textContent).toContain("Your organisation's Microsoft admin must approve");
  });

  it("another person's account is health only: no Reconnect, no Disconnect, no chats, and it never changes the viewer's own Sign in", () => {
    draw(teams({ connections: [conn({ mine: false, account: "robert@teams.example.test" })] }));
    const other = screen.getByTestId("teams-other-connection");
    expect(other.textContent).toContain("robert@teams.example.test");
    expect(other.textContent).toContain("never its chats");
    expect(within(other).queryByRole("button")).toBeNull();
    expect(screen.getByTestId("teams-not-connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in to Teams" })).toBeTruthy();
  });

  it("paused: rows kept with the paused badge, no Sign in or Reconnect, Disconnect for the owner", () => {
    draw(teams({ paused: true }));
    const row = screen.getByTestId("teams-connection");
    expect(within(row).getByText("Paused: Teams is not enabled for this company")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /Reconnect/ })).toBeNull();
    expect(within(row).getByRole("button", { name: /Disconnect/ })).toBeTruthy();
    expect(row.textContent).toContain("Nothing was deleted");
  });

  it("settings unknown and rows unavailable: notices, no Sign in or Reconnect", () => {
    draw(teams({ settingsUnknown: true }));
    expect(screen.getByTestId("teams-settings-unknown")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sign in|Reconnect/ })).toBeNull();
    cleanup();
    draw(teams({ unavailable: true, connections: [] }));
    expect(screen.getByTestId("teams-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("teams-not-connected")).toBeNull();
  });

  it("the Google and Microsoft sections are unchanged and independent: a Google-only company has a Teams row beside its Google row", () => {
    draw(teams({ connections: [] }), google(), null);
    expect(screen.getByTestId("google-connection")).toBeTruthy();
    expect(screen.queryByTestId("microsoft-connection")).toBeNull();
    expect(screen.getByTestId("teams-not-connected")).toBeTruthy();
    cleanup();
    draw(null, google(), null);
    expect(screen.queryByTestId("teams-not-connected")).toBeNull();
    expect(screen.queryByTestId("teams-notes")).toBeNull();
  });

  it("the notes say it is not the portal sign-in and how to remove the app at Microsoft", () => {
    draw(teams());
    const notes = screen.getByTestId("teams-notes").textContent ?? "";
    expect(notes).toContain("It is not your portal sign-in");
    expect(notes).toContain("does not contact Microsoft");
    expect(notes).toContain("My Apps");
  });
});

describe("Disconnect", () => {
  it("asks first, then posts to the Teams disconnect route and returns to Settings with the Teams result", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "disconnected" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    draw(teams());
    fireEvent.click(screen.getByRole("button", { name: "Disconnect me@teams.example.test" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("teams-disconnect-confirm").textContent).toContain("Microsoft may still list the app");
    fireEvent.click(within(screen.getByTestId("teams-disconnect-confirm")).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/PKG/settings?connect=disconnected&provider=microsoft_teams"));
    expect(fetchMock).toHaveBeenCalledWith(`/api/lanes/PKG/connections/${ID}/disconnect-teams`, { method: "POST" });
  });

  it("a refusal shows a fixed text chosen by the status, never the server's reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "server-text-canary" }), { status: 403 })));
    draw(teams());
    fireEvent.click(screen.getByRole("button", { name: "Disconnect me@teams.example.test" }));
    fireEvent.click(within(screen.getByTestId("teams-disconnect-confirm")).getByRole("button", { name: "Disconnect" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Only the person who connected this account can disconnect it");
    expect(document.body.textContent).not.toContain("server-text-canary");
    expect(nav.replace).not.toHaveBeenCalled();
  });
});

describe("T-278 review", () => {
  it("S2: a disconnected row beside another usable one has no Reconnect (it could only fail) and says why; alone it keeps Reconnect", () => {
    draw(teams({ connections: [conn({ id: "00000000-0000-4000-8000-0000000000d1", account: "old@teams.example.test", state: "disconnected" }), conn()] }));
    expect(screen.queryByRole("button", { name: "Reconnect old@teams.example.test" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect me@teams.example.test" })).toBeTruthy();
    expect(document.body.textContent).toContain("Disconnect another Teams account first to use this one again.");
    cleanup();
    draw(teams({ connections: [conn({ state: "disconnected" })] }));
    expect(screen.getByRole("button", { name: "Reconnect me@teams.example.test" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in to Teams" })).toBeTruthy();
  });

  it("C5: a company on a cloud this build does not serve is shown as that, not as 'not enabled'", () => {
    draw(teams({ paused: true, unsupportedCloud: true }));
    expect(screen.getByText("Paused: this Microsoft cloud is not supported for Teams yet")).toBeTruthy();
    expect(screen.queryByText("Paused: Teams is not enabled for this company")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// T-294 (spec 22.10): several Teams accounts per person. The section lists one row per own connection with its own Reconnect and Disconnect, offers "Connect another Teams account" while
// the person is under the company's limit, says so at the limit, and looks as before with a limit of 1.
describe("T-294: Your Teams accounts", () => {
  const A = "00000000-0000-4000-8000-0000000000a1";
  const B = "00000000-0000-4000-8000-0000000000b2";
  const two = (over: Partial<TeamsSectionView> = {}) => teams({ maxAccounts: 2, connections: [conn({ id: A, account: "robert@pubkgroup.example.test" }), conn({ id: B, account: "robert@pub-k.example.test" })], ...over });
  const widths = [1280, 375];

  it.each(widths)("two accounts at limit 2 (width %i): one row each with its own Reconnect and Disconnect, the at-limit note, no Connect another and no Sign in", (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    draw(two());
    const rows = screen.getAllByTestId("teams-connection");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("Your Teams accounts")).toBeTruthy();
    for (const [row, id, account] of [[rows[0], A, "robert@pubkgroup.example.test"], [rows[1], B, "robert@pub-k.example.test"]] as const) {
      expect(within(row as HTMLElement).getByText(account)).toBeTruthy();
      expect(within(row as HTMLElement).getByRole("button", { name: `Reconnect ${account}` }).closest("form")?.getAttribute("action")).toBe(`/api/connect/teams/start?lane=PKG&connection=${id}`);
      expect(within(row as HTMLElement).getByRole("button", { name: `Disconnect ${account}` })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Connect another Teams account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in to Teams" })).toBeNull();
    expect(screen.getByTestId("teams-at-limit").textContent).toBe("You have connected 2 Teams accounts, the most this company allows.");
  });

  it.each(widths)("one account at limit 2 (width %i): 'Connect another Teams account' posts the same start WITHOUT a connection id (a first connect); no at-limit note", (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    draw(teams({ maxAccounts: 2 }));
    const button = screen.getByRole("button", { name: "Connect another Teams account" });
    expect(button.closest("form")?.getAttribute("action")).toBe("/api/connect/teams/start?lane=PKG");
    expect(button.closest("form")?.getAttribute("method")).toBe("post");
    expect(screen.queryByTestId("teams-at-limit")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in to Teams" })).toBeNull();
  });

  it("no account at limit 2: Sign in to Teams (not 'Connect another'); a disconnected row alone keeps its Reconnect", () => {
    draw(teams({ maxAccounts: 2, connections: [] }));
    expect(screen.getByRole("button", { name: "Sign in to Teams" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect another Teams account" })).toBeNull();
    cleanup();
    draw(teams({ maxAccounts: 2, connections: [conn({ state: "disconnected" })] }));
    expect(screen.getByRole("button", { name: "Reconnect me@teams.example.test" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in to Teams" })).toBeTruthy();
  });

  it("limit 1 with one account looks as before: singular title, no Connect another, no at-limit note, no 'several' note", () => {
    draw(teams());
    expect(within(screen.getByTestId("teams-connection")).getByText("Your Teams account")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect another Teams account" })).toBeNull();
    expect(screen.queryByTestId("teams-at-limit")).toBeNull();
    expect(screen.queryByTestId("teams-several-note")).toBeNull();
  });

  it("the limit lowered below what the person has: both rows keep working, nothing to add, and a disconnected third cannot come back (the fixed sentence, no button)", () => {
    draw(teams({ maxAccounts: 1, connections: [conn({ id: A, account: "a@teams.example.test" }), conn({ id: B, account: "b@teams.example.test" }), conn({ id: "00000000-0000-4000-8000-0000000000c3", account: "c@teams.example.test", state: "disconnected" })] }));
    expect(screen.getAllByTestId("teams-connection")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Reconnect a@teams.example.test" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect b@teams.example.test" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect c@teams.example.test" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect another Teams account" })).toBeNull();
    expect(document.body.textContent).toContain("Disconnect another Teams account first to use this one again.");
  });

  it("a disconnected row of someone under the limit can be reconnected", () => {
    draw(teams({ maxAccounts: 2, connections: [conn({ id: A, account: "a@teams.example.test" }), conn({ id: B, account: "b@teams.example.test", state: "disconnected" })] }));
    expect(screen.getByRole("button", { name: "Reconnect b@teams.example.test" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect another Teams account" })).toBeTruthy();
  });

  it("another person's rows stay health-only, several per person, and never count toward my limit or draw a button", () => {
    draw(teams({ maxAccounts: 2, connections: [conn({ id: A, account: "me@teams.example.test" }), conn({ id: B, account: "x@teams.example.test", mine: false }), conn({ id: "00000000-0000-4000-8000-0000000000c4", account: "y@teams.example.test", mine: false })] }));
    expect(screen.getAllByTestId("teams-other-connection")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Reconnect x@teams.example.test" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect another Teams account" })).toBeTruthy(); // my one row vs the limit of 2
  });

  it("a paused section or unreadable settings offer no Connect another and no Sign in", () => {
    draw(two({ paused: true, connections: [conn({ id: A })] }));
    expect(screen.queryByRole("button", { name: "Connect another Teams account" })).toBeNull();
    cleanup();
    draw(teams({ maxAccounts: 2, settingsUnknown: true }));
    expect(screen.queryByRole("button", { name: "Connect another Teams account" })).toBeNull();
  });
});
