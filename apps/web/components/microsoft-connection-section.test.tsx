// @vitest-environment jsdom
// T-257: the Microsoft rows beside the Google rows. Both sections, paused rows (no Connect or Reconnect, Disconnect for the owner), other people's
// rows as health only, the admin consent link and the fixed wording. Mocks only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

import { ConnectionsSection } from "./connections-section";
import { MICROSOFT_PAUSED_TEXT } from "./microsoft-connection-section";
import { GOOGLE_PAUSED_TEXT } from "./google-connection-section";
import type { GoogleSectionView } from "@/lib/google-connection";
import type { MicrosoftSectionView } from "@/lib/microsoft-connection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  nav.replace.mockClear();
});

const conn = (over: Partial<GoogleSectionView["connections"][number]> = {}) => ({ id: "00000000-0000-4000-8000-0000000000c2", mailbox: "me@corp.example.test", state: "connected" as const, mailboxAllowed: true, mine: true, lastMailSyncAt: null, lastCalendarSyncAt: null, ...over });
const ms = (over: Partial<MicrosoftSectionView> = {}): MicrosoftSectionView => ({ connections: [conn()], adminConsentUrl: null, ...over });
const google = (over: Partial<GoogleSectionView> = {}): GoogleSectionView => ({ connections: [conn({ id: "00000000-0000-4000-8000-0000000000c1" })], ...over });
const draw = (g: GoogleSectionView | null, m: MicrosoftSectionView | null) => render(<ConnectionsSection laneId="PKG" google={g} microsoft={m} quickbooks={null} composio={null} />);
const LINK = "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0/adminconsent?client_id=synthetic";

describe("both providers enabled", () => {
  it("draws both sections; the same user's Google and Microsoft rows are each in their own", () => {
    draw(google(), ms());
    const g = screen.getByTestId("google-connection");
    const m = screen.getByTestId("microsoft-connection");
    expect(within(g).getByText("Your Google account")).toBeTruthy();
    expect(within(m).getByText("Your Microsoft account")).toBeTruthy();
    expect(within(m).queryByText(/Google/)).toBeNull();
    expect(within(g).queryByText(/Microsoft/)).toBeNull();
    expect(within(m).getByRole("button", { name: "Reconnect me@corp.example.test" })).toBeTruthy();
    expect(within(m).getByRole("button", { name: "Connect another Microsoft account" })).toBeTruthy();
    expect(within(m).getByRole("button", { name: "Disconnect me@corp.example.test" })).toBeTruthy();
  });
  it("Connect and Reconnect post to the Microsoft start route for this lane (a reconnect names its row)", () => {
    draw(google(), ms({ connections: [] }));
    const connect = screen.getByRole("button", { name: "Connect Microsoft" }).closest("form");
    expect(connect?.getAttribute("action")).toBe("/api/connect/microsoft/start?lane=PKG");
    expect(connect?.getAttribute("method")).toMatch(/post/i);
    cleanup();
    draw(null, ms());
    expect(screen.getByRole("button", { name: "Reconnect me@corp.example.test" }).closest("form")?.getAttribute("action")).toBe("/api/connect/microsoft/start?lane=PKG&connection=00000000-0000-4000-8000-0000000000c2");
  });
  it("says it connects mail and calendar read-only, is not a sign-in, and where to remove the app; no 'now uses' note", () => {
    draw(google(), ms());
    const t = screen.getByTestId("microsoft-notes").textContent ?? "";
    expect(t).toMatch(/mail and calendar, read-only/);
    expect(t).toMatch(/not how anyone signs in/);
    expect(t).toMatch(/does not contact Microsoft/);
    expect(t).toMatch(/Entra admin center \(Enterprise apps → the app → Permissions\)/);
    expect(document.body.textContent).not.toMatch(/now uses/i);
  });
});

describe("only Google", () => {
  it("no Microsoft section at all: no row, no notes, no Connect Microsoft button", () => {
    draw(google(), null);
    expect(screen.queryByTestId("microsoft-connection")).toBeNull();
    expect(screen.queryByTestId("microsoft-notes")).toBeNull();
    expect(screen.queryByRole("button", { name: /Microsoft/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect me@corp.example.test" })).toBeTruthy(); // Google untouched
  });
});

describe("Microsoft disabled after a connect", () => {
  it("the row is kept and shown as paused: no Reconnect, no Connect, data kept, Disconnect still there", () => {
    draw(null, ms({ paused: true, connections: [conn({ state: "reconnect_required" })] }));
    const row = screen.getByTestId("microsoft-connection");
    expect(within(row).getByText(MICROSOFT_PAUSED_TEXT)).toBeTruthy();
    expect(MICROSOFT_PAUSED_TEXT).toBe("Paused: Microsoft is not enabled for this company");
    expect(within(row).queryByRole("button", { name: /Reconnect/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    expect(within(row).getByRole("button", { name: /Disconnect/ })).toBeTruthy();
    expect(row.textContent).toMatch(/Nothing was deleted/);
    expect(screen.queryByText(/needs to be reconnected/)).toBeNull();
    expect(screen.queryByTestId("microsoft-admin-consent")).toBeNull();
    expect(document.body.textContent).not.toMatch(/now uses/i);
  });
  it("another person's paused row is status only", () => {
    draw(google(), ms({ paused: true, connections: [conn({ mine: false })] }));
    const row = screen.getByTestId("microsoft-other-connection");
    expect(within(row).getByText(MICROSOFT_PAUSED_TEXT)).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
  });
});

describe("Google paused", () => {
  it("lists the Google rows as paused with no Connect or Reconnect, and no Disconnect (Google has none yet)", () => {
    draw(google({ paused: true }), null);
    const row = screen.getByTestId("google-connection");
    expect(within(row).getByText(GOOGLE_PAUSED_TEXT)).toBeTruthy();
    expect(GOOGLE_PAUSED_TEXT).toBe("Paused: Google is not enabled for this company");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("other people's accounts", () => {
  it("health only: address, status and sync times, no button of any kind", () => {
    draw(null, ms({ connections: [conn({ mine: false, mailbox: "other@corp.example.test", state: "degraded" })] }));
    const row = screen.getByTestId("microsoft-other-connection");
    expect(row.textContent).toContain("other@corp.example.test");
    expect(row.textContent).toContain("Connected, with problems");
    expect(within(row).queryByRole("button")).toBeNull();
    expect(within(row).queryByRole("link")).toBeNull();
  });
});

describe("the admin consent note", () => {
  it("shows the link as given by the server, opening in a new tab without a referrer", () => {
    draw(null, ms({ adminConsentUrl: LINK }));
    const a = within(screen.getByTestId("microsoft-admin-consent")).getByRole("link", { name: "Administrator approval link" });
    expect(a.getAttribute("href")).toBe(LINK);
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("no link, no note", () => {
    draw(null, ms());
    expect(screen.queryByTestId("microsoft-admin-consent")).toBeNull();
  });
});

describe("unavailable", () => {
  it("says so, with no rows and no buttons", () => {
    draw(google(), { connections: [], unavailable: true, adminConsentUrl: null });
    expect(screen.getByTestId("microsoft-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("microsoft-not-connected")).toBeNull();
    expect(screen.queryByRole("button", { name: /Microsoft/ })).toBeNull();
  });
});

describe("Disconnect (client)", () => {
  const open = () => {
    draw(null, ms());
    fireEvent.click(screen.getByRole("button", { name: "Disconnect me@corp.example.test" }));
  };
  it("asks first: nothing is sent until the confirm button; the text says nothing is sent to Microsoft", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    open();
    const dialog = screen.getByTestId("microsoft-disconnect-confirm");
    expect(dialog.textContent).toMatch(/Nothing is sent to Microsoft/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it connected" }));
    expect(screen.queryByTestId("microsoft-disconnect-confirm")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("confirm: one POST to this lane's disconnect route for this row, then back to Settings with the fixed result", async () => {
    const fetchSpy = vi.fn<(url: string, init: unknown) => Promise<Response>>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    open();
    fireEvent.click(within(screen.getByTestId("microsoft-disconnect-confirm")).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/PKG/settings?connect=disconnected&provider=microsoft"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]).toEqual(["/api/lanes/PKG/connections/00000000-0000-4000-8000-0000000000c2/disconnect", { method: "POST" }]);
  });
  it("a refusal shows a fixed text by status and stays on the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "canary-server-text" }), { status: 403 })));
    open();
    fireEvent.click(within(screen.getByTestId("microsoft-disconnect-confirm")).getByRole("button", { name: "Disconnect" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Only the person who connected this account/);
    expect(document.body.textContent).not.toContain("canary-server-text");
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
