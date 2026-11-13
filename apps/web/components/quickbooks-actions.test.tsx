// @vitest-environment jsdom
// T-197: the Disconnect button (confirm, propose, pending), the error-log download and the shared banner. Mocks only (rule 10).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

import { QuickBooksDisconnectButton } from "./quickbooks-disconnect-button";
import { QuickBooksErrorExport } from "./quickbooks-error-export";
import { QuickBooksErrorBanner } from "./quickbooks-error-banner";

const CONN = "00000000-0000-4000-8000-000000002901";
const none = { pendingId: null, gate: null };
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

describe("QuickBooksDisconnectButton", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("the first click only opens the confirm; nothing is sent, and it explains what happens", () => {
    render(<QuickBooksDisconnectButton laneId="PKG" connectionId={CONN} disconnect={none} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect QuickBooks" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/end its access/);
    expect(dialog.textContent).toMatch(/deletes the saved connection/);
    expect(dialog.textContent).toMatch(/stops syncing/);
    expect(dialog.textContent).toMatch(/approve/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Keep it connected closes the confirm without a request", () => {
    render(<QuickBooksDisconnectButton laneId="PKG" connectionId={CONN} disconnect={none} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect QuickBooks" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it connected" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirming posts propose_qbo_disconnect for this lane and connection only, then refreshes", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, id: "x", hash: "y" }), { status: 200 }));
    render(<QuickBooksDisconnectButton laneId="PKG" connectionId={CONN} disconnect={none} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect QuickBooks" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask to disconnect" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/lanes/PKG/approvals");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ action: "propose_qbo_disconnect", connectionId: CONN });
  });

  it("a refusal shows the server's message (or a fixed one) and does not refresh", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));
    render(<QuickBooksDisconnectButton laneId="PKG" connectionId={CONN} disconnect={none} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect QuickBooks" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask to disconnect" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/owner or technical administrator/);
    expect(refresh).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "One is already waiting." }), { status: 409 }));
    fireEvent.click(screen.getByRole("button", { name: "Ask to disconnect" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("One is already waiting."));
  });

  it("a network failure shows a fixed message", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<QuickBooksDisconnectButton laneId="PKG" connectionId={CONN} disconnect={none} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect QuickBooks" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask to disconnect" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not work/);
  });

  it("with approving switched off the confirm says why but still lets you ask", () => {
    render(<QuickBooksDisconnectButton laneId="PKG" connectionId={CONN} disconnect={{ pendingId: null, gate: { enabled: false, message: "Approving is not set up yet." } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect QuickBooks" }));
    expect(screen.getByRole("dialog").textContent).toContain("Approving is not set up yet.");
    expect(screen.getByRole("button", { name: "Ask to disconnect" }).hasAttribute("disabled")).toBe(false);
  });

  it("while one is waiting: no button, a link to Approvals", () => {
    render(<QuickBooksDisconnectButton laneId="PKG" connectionId={CONN} disconnect={{ pendingId: "a1", gate: { enabled: true, message: null } }} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Disconnect waiting for approval")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Approvals" }).getAttribute("href")).toBe("/PKG/approvals");
  });
});

describe("QuickBooksErrorExport", () => {
  it("defaults to the given range and links to the export route for CSV and JSON of this lane", () => {
    render(<QuickBooksErrorExport laneId="PKG" defaultFrom="2026-10-15" defaultTo="2026-11-13" />);
    const box = screen.getByTestId("qbo-error-export");
    const csv = within(box).getByRole("link", { name: "Download CSV" }).getAttribute("href") as string;
    const json = within(box).getByRole("link", { name: "Download JSON" }).getAttribute("href") as string;
    expect(csv).toBe("/api/lanes/PKG/connector-errors/export?from=2026-10-15&to=2026-11-13&format=csv&dataset=errors");
    expect(json).toContain("format=json");
  });
  it("a range over 90 days or backwards turns the links off with a message", () => {
    render(<QuickBooksErrorExport laneId="PKG" defaultFrom="2026-10-15" defaultTo="2026-11-13" />);
    const [from] = screen.getAllByLabelText(/From/);
    fireEvent.change(from as HTMLElement, { target: { value: "2026-01-01" } });
    expect(screen.queryByRole("link", { name: "Download CSV" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/at most 90 days/);
    fireEvent.change(from as HTMLElement, { target: { value: "2026-12-01" } });
    expect(screen.getByRole("alert").textContent).toMatch(/not be before/);
  });
});

describe("QuickBooksErrorBanner", () => {
  it.each(["reconnect_required", "degraded", "unavailable"] as const)("%s: fixed text and a Contact support mailto", (kind) => {
    render(<QuickBooksErrorBanner kind={kind} />);
    expect(screen.getByRole("link", { name: "Contact support" }).getAttribute("href")).toMatch(/^mailto:it@pub-k\.org/);
    expect(screen.getByRole("alert").textContent).toMatch(/QuickBooks/);
  });
});
