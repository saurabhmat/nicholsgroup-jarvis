// @vitest-environment jsdom
// T-195: the QuickBooks disconnect card: what will happen, which company (realm id), who asked, Approve (step-up) and Reject,
// the disabled reasons, and the outcome texts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DisconnectCard } from "@/lib/approvals";
import { DisconnectApprovalCard } from "./disconnect-card";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  push.mockReset();
  refresh.mockReset();
});

const ID = "00000000-0000-4000-8000-0000000000aa";
const card = (over: Partial<DisconnectCard> = {}): DisconnectCard => ({
  id: ID,
  actionType: "qbo.disconnect",
  realmId: "9341450000000001",
  proposedByYou: true,
  hash: "a".repeat(64),
  shortHash: "aaaaaaaa",
  expiresAt: "2026-11-14T12:00:00Z",
  capability: { enabled: true, message: null, settingsHref: null },
  ...over,
});
const reply = (status: number, body: Record<string, unknown>) => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("DisconnectApprovalCard", () => {
  it("says what will happen and for which company, who asked, and shows the short hash", () => {
    render(<DisconnectApprovalCard laneId="PKG" card={card()} canAct />);
    expect(screen.getByTestId("disconnect-company").textContent).toContain("9341450000000001");
    expect(screen.getByText(/tells QuickBooks to end its access/)).toBeTruthy();
    expect(screen.getByText(/Nothing inside QuickBooks is changed or deleted/)).toBeTruthy();
    expect(screen.getByText("Asked for by you.")).toBeTruthy();
    expect(screen.getByText("#aaaaaaaa")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve and disconnect" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("says when another administrator asked", () => {
    render(<DisconnectApprovalCard laneId="PKG" card={card({ proposedByYou: false })} canAct />);
    expect(screen.getByText(/another administrator/)).toBeTruthy();
  });

  it("Approve is off, with the exact reason, when the company has not allowed it or approvals are not live", () => {
    const message = "Disconnecting QuickBooks isn't enabled for this company yet. Ask your administrator to allow it.";
    render(<DisconnectApprovalCard laneId="PKG" card={card({ capability: { enabled: false, message, settingsHref: null } })} canAct />);
    expect((screen.getByRole("button", { name: "Approve and disconnect" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("approve-disabled-reason").textContent).toBe(message);
  });

  it("a person who may not act sees no buttons", () => {
    render(<DisconnectApprovalCard laneId="PKG" card={card()} canAct={false} />);
    expect(screen.queryByRole("button", { name: "Approve and disconnect" })).toBeNull();
    expect(screen.getByText(/Only an owner or administrator/)).toBeTruthy();
  });

  it("approve sends the exact hash shown; success tells the person to reconnect in Settings when ready", async () => {
    const spy = reply(200, { ok: true, status: "verified", outcome: "disconnected" });
    render(<DisconnectApprovalCard laneId="PKG" card={card()} canAct />);
    fireEvent.click(screen.getByTestId("approve"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/disconnected and checked/));
    expect(JSON.parse(String((spy.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ action: "approve", id: ID, hashSeen: "a".repeat(64) });
    expect(refresh).toHaveBeenCalled();
  });

  it("a stale authenticator code sends the person to the re-authentication page and back", async () => {
    reply(403, { error: "step_up_required" });
    render(<DisconnectApprovalCard laneId="PKG" card={card()} canAct />);
    fireEvent.click(screen.getByTestId("approve"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/mfa?reauth=1&next=%2FPKG%2Fapprovals"));
  });

  it("a failed disconnect says QuickBooks is still connected; an unconfirmed one says to check Settings", async () => {
    reply(200, { ok: true, status: "failed", outcome: "failed" });
    const a = render(<DisconnectApprovalCard laneId="PKG" card={card()} canAct />);
    fireEvent.click(screen.getByTestId("approve"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/still connected/));
    a.unmount();
    reply(200, { ok: true, status: "failed", outcome: "unknown" });
    render(<DisconnectApprovalCard laneId="PKG" card={card()} canAct />);
    fireEvent.click(screen.getByTestId("approve"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/could not be confirmed/));
  });

  it("reject needs a reason and sends it", async () => {
    const spy = reply(200, { ok: true });
    render(<DisconnectApprovalCard laneId="PKG" card={card()} canAct />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    const send = screen.getAllByRole("button", { name: "Reject" })[0] as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Why are you rejecting this?"), { target: { value: "Not now" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0] as HTMLButtonElement);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(JSON.parse(String((spy.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ action: "reject", id: ID, reason: "Not now" });
  });
});
