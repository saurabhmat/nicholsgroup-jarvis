// @vitest-environment jsdom
// T-232: the approval card. "Sends as", the exact disabled messages with the Settings link, the approve label per type,
// and that approve is off while there are unsaved edits.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PendingCard } from "@/lib/approvals";
import { ApprovalCard } from "./approval-card";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);

const card = (over: Partial<PendingCard> = {}): PendingCard => ({
  id: "00000000-0000-4000-8000-0000000000aa",
  actionType: "email.send",
  mailbox: "exec@pubkgroup.example.test",
  to: ["dana@sender.example.test"],
  cc: [],
  bcc: [],
  subject: "Update",
  bodyText: "Hello Dana",
  rationale: null,
  derivedFromRetrieved: false,
  hash: "a".repeat(64),
  shortHash: "aaaaaaaa",
  expiresAt: "2026-11-14T12:00:00Z",
  replyThread: false,
  recipientFlags: [],
  capability: { enabled: true, message: null, settingsHref: null },
  ...over,
});

describe("review fixes (T-232)", () => {
  it("shows a warning per external or bcc recipient", () => {
    render(<ApprovalCard laneId="PKG" card={card({ recipientFlags: [{ address: "x@evil.example.test", field: "bcc", flags: ["external", "bcc"] }] })} canAct />);
    const flags = screen.getByTestId("recipient-flags");
    expect(flags.textContent).toContain("x@evil.example.test");
    expect(flags.textContent).toContain("Outside your company");
    expect(flags.textContent).toContain("Hidden copy (Bcc)");
  });
  it("a reply's subject is read-only and says why", () => {
    render(<ApprovalCard laneId="PKG" card={card({ replyThread: true })} canAct />);
    const subject = screen.getByLabelText(/^Subject/) as HTMLInputElement;
    expect(subject.readOnly).toBe(true);
    expect(screen.getByText(/keeps its subject/)).toBeTruthy();
  });
});

describe("ApprovalCard", () => {
  it("always says which address it sends as, shows the short hash and offers Approve & send", () => {
    render(<ApprovalCard laneId="PKG" card={card()} canAct />);
    expect(screen.getByTestId("sends-as").textContent).toBe("Sends as exec@pubkgroup.example.test");
    expect(screen.getByText("#aaaaaaaa")).toBeTruthy();
    const approve = screen.getByRole("button", { name: "Approve & send" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
  });

  it("a draft action says Save as Gmail draft", () => {
    render(<ApprovalCard laneId="PKG" card={card({ actionType: "email.save_draft" })} canAct />);
    expect(screen.getByRole("button", { name: "Save as Gmail draft" })).toBeTruthy();
  });

  it("disabled with exactly the reconnect message and a link to Settings when the mailbox cannot send", () => {
    const message = "Sending isn't enabled for this mailbox yet. Reconnect Google with send permission in Settings";
    render(<ApprovalCard laneId="PKG" card={card({ capability: { enabled: false, message, settingsHref: "/PKG/settings#connections" } })} canAct />);
    expect((screen.getByRole("button", { name: "Approve & send" }) as HTMLButtonElement).disabled).toBe(true);
    const reason = screen.getByTestId("approve-disabled-reason");
    expect(reason.textContent).toBe(message);
    expect(reason.querySelector("a")?.getAttribute("href")).toBe("/PKG/settings#connections");
  });

  it("disabled with the not-live message when approvals are not live", () => {
    render(<ApprovalCard laneId="PKG" card={card({ capability: { enabled: false, message: "Approvals are not live for this company yet.", settingsHref: null } })} canAct />);
    expect((screen.getByRole("button", { name: "Approve & send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("approve-disabled-reason").textContent).toBe("Approvals are not live for this company yet.");
  });

  it("an unsaved edit turns Approve off and Save changes on", () => {
    render(<ApprovalCard laneId="PKG" card={card()} canAct />);
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Changed" } });
    expect((screen.getByRole("button", { name: "Approve & send" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the derived-from-email banner and the unverified assistant note", () => {
    render(<ApprovalCard laneId="PKG" card={card({ derivedFromRetrieved: true, rationale: "Dana asked for the numbers" })} canAct />);
    expect(screen.getByText("Recipients came from an email")).toBeTruthy();
    expect(screen.getByText(/Assistant's note \(not verified\)/)).toBeTruthy();
  });

  it("a non-owner sees the content read-only without buttons", () => {
    render(<ApprovalCard laneId="PKG" card={card()} canAct={false} />);
    expect(screen.queryByRole("button", { name: "Approve & send" })).toBeNull();
    expect((screen.getByLabelText("Subject") as HTMLInputElement).disabled).toBe(true);
  });
});
