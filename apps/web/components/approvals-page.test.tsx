// @vitest-environment jsdom
// T-263: the Approval Center lists a Gmail and an Outlook proposal of one lane together, each labelled with its provider and its sending mailbox; an Outlook action whose outcome is
// unknown says where to look. The data layer is replaced (the view model is tested in lib/approvals.test.ts); synthetic data only.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalsView, PendingCard } from "@/lib/approvals";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@nichols/approvals/wire", () => ({ approvalsDeps: {} }));
vi.mock("@/lib/guards", () => ({ guards: async () => ({}) }));
vi.mock("@/lib/lane-page", () => ({ loadLane: async () => ({ laneId: "PKG" }) }));
vi.mock("@/lib/timed", () => ({ timed: async (_n: string, f: () => Promise<unknown>) => f() }));
const view = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/approvals", () => ({ loadApprovals: async () => view.current }));
import { ApprovalsBody } from "./approvals-page";

afterEach(cleanup);
const card = (id: string, provider: "google" | "microsoft", mailbox: string, type: PendingCard["actionType"] = "email.send"): PendingCard => ({
  id, actionType: type, provider, mailbox, to: ["dana@sender.example.test"], cc: [], bcc: [], subject: `Subject ${id}`, bodyText: "Body", rationale: null, derivedFromRetrieved: false,
  hash: "a".repeat(64), shortHash: "aaaaaaaa", expiresAt: "2026-11-25T12:00:00Z", replyThread: false, recipientFlags: [], capability: { enabled: true, message: null, settingsHref: null }, placeholder: null,
});

describe("Approvals page with both providers", () => {
  it("shows a Gmail and an Outlook proposal together, each with its provider badge and its own 'Sends as <mailbox>'", async () => {
    view.current = {
      isOwner: true, canActDisconnect: false, disconnects: [], history: [],
      pending: [card("00000000-0000-4000-8000-0000000000a1", "google", "robert@pubk.example.test"), card("00000000-0000-4000-8000-0000000000a2", "microsoft", "robert@pubkgroup.example.test", "email.save_draft")],
    } satisfies ApprovalsView;
    render(await ApprovalsBody({ laneId: "PKG" }));
    const cards = screen.getAllByTestId("approval-card");
    expect(cards).toHaveLength(2);
    const [g, m] = cards as [HTMLElement, HTMLElement];
    expect(within(g).getByTestId("approval-provider").textContent).toBe("Gmail");
    expect(within(g).getByTestId("sends-as").textContent).toBe("Sends as robert@pubk.example.test");
    expect(within(m).getByTestId("approval-provider").textContent).toBe("Outlook");
    expect(within(m).getByTestId("sends-as").textContent).toBe("Sends as robert@pubkgroup.example.test");
    expect(within(m).getByRole("button", { name: "Save as Outlook draft" })).toBeTruthy();
    expect(within(g).getByRole("button", { name: "Approve & send" })).toBeTruthy();
  });

  it("history: each line names its provider; an unknown outcome of an Outlook action says to check Drafts and Sent Items in Outlook, a Gmail one keeps its wording", async () => {
    const h = (id: string, provider: "google" | "microsoft") => ({ id, actionType: "email.send" as const, provider, status: "failed" as const, to: ["dana@sender.example.test"], subject: "S", failureCode: "outcome_unknown", outcomeUnknown: true, at: "2026-11-22T12:00:00Z", contentPurged: true });
    view.current = { isOwner: true, canActDisconnect: false, disconnects: [], pending: [], history: [h("00000000-0000-4000-8000-0000000000b1", "google"), h("00000000-0000-4000-8000-0000000000b2", "microsoft")] } satisfies ApprovalsView;
    render(await ApprovalsBody({ laneId: "PKG" }));
    const notes = screen.getAllByTestId("approvals-outcome-unknown").map((n) => n.textContent ?? "");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toBe("Outcome unknown: it may have been sent. Check the mailbox before asking for it again.");
    expect(notes[1]).toMatch(/Check Drafts and Sent Items in Outlook before trying again\.$/);
    const lines = within(screen.getByTestId("approvals-history")).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(lines[0]).toContain("Gmail");
    expect(lines[1]).toContain("Outlook");
  });
});
