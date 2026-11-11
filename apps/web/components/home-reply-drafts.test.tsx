// @vitest-environment jsdom
// T-231d: reply drafts on Home. Thread (masked subject), recipient from metadata, status label, context, text, Copy,
// the link to the proposal in Approvals, further replies by name; nothing for a failed briefing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SavedBriefingView } from "@/lib/briefing";
import { ReplyDrafts } from "./home-reply-drafts";

afterEach(cleanup);

const ref = (n: number, over: Record<string, unknown> = {}) => ({
  ref: `r${String(n)}`,
  connectionId: "c1",
  messageId: `m${String(n)}`,
  threadKey: `t${String(n)}`,
  mailbox: "me@pubk.test",
  fromAddress: `p${String(n)}@acme.test`,
  fromName: `Person ${String(n)}`,
  subject: `Renewal $1,200 #${String(n)}`,
  receivedAt: "2026-11-11T10:00:00Z",
  sourceUrl: "https://mail.google.com/x",
  reason: "waiting",
  kind: "waiting",
  ...over,
});
const brief = (over: Partial<SavedBriefingView["content"]> = {}, status: SavedBriefingView["status"] = "ready"): SavedBriefingView => ({
  id: "b1",
  status,
  trigger: "manual",
  preparedAt: "2026-11-11T12:00:00Z",
  windowFrom: "2026-11-10T12:00:00Z",
  windowTo: "2026-11-11T12:00:00Z",
  lastFailedAt: null,
  lastRunAt: null,
  refs: [ref(1), ref(2), ref(3)],
  content: {
    lines: [],
    attention: [],
    deadlines: [],
    priorities: [],
    replies: [
      { ref: "r1", status: "ready", context: "They asked to confirm", text: "Thanks, confirmed.", proposalId: "00000000-0000-4000-8000-0000000000d1" },
      { ref: "r2", status: "awaiting_input", context: "Needs a price", text: "", proposalId: null },
    ],
    moreReplies: ["r3"],
    notes: [],
    ...over,
  },
});

describe("ReplyDrafts", () => {
  it("shows each draft with recipient, status, context, text, Copy and the Approvals link", () => {
    render(<ReplyDrafts laneId="PKG" brief={brief()} tz="America/New_York" />);
    const items = screen.getAllByTestId("reply-draft");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("To p1@acme.test");
    expect(items[0]?.textContent).toContain("Ready for your review");
    expect(items[0]?.textContent).toContain("They asked to confirm");
    expect(items[0]?.textContent).not.toContain("1,200"); // subject masked on Home (rule 7)
    expect(screen.getByTestId("reply-text").textContent).toBe("Thanks, confirmed.");
    expect(screen.getByRole("link", { name: "Review in Approvals" }).getAttribute("href")).toBe("/PKG/approvals#action-00000000-0000-4000-8000-0000000000d1");
    expect(items[1]?.textContent).toContain("Awaiting your input");
    expect(items[1]?.textContent).toContain("needs your decision");
    expect(screen.getByTestId("more-replies").textContent).toContain("Person 3");
  });

  it("'Open thread' opens the thread in Jarvis, not the stored Google link", () => {
    render(<ReplyDrafts laneId="PKG" brief={brief()} tz="America/New_York" />);
    expect(screen.getAllByRole("link", { name: "Open thread" }).map((a) => a.getAttribute("href"))).toEqual(["/PKG/inbox/m1", "/PKG/inbox/m2"]);
  });

  it("a re-run links to the earlier draft waiting in Approvals; a failure says to copy instead (never a raw code)", () => {
    render(
      <ReplyDrafts
        laneId="PKG"
        brief={brief({
          replies: [
            { ref: "r1", status: "ready", context: "", text: "Hi", proposalId: null },
            { ref: "r2", status: "ready", context: "", text: "Hello", proposalId: null },
          ],
          notes: ["reply_proposal_exists:r1", "reply_proposal_failed:r2"],
        })}
        tz="America/New_York"
      />,
    );
    expect(screen.getByRole("link", { name: "An earlier draft is waiting in Approvals" }).getAttribute("href")).toBe("/PKG/approvals");
    expect(screen.getByText(/Could not be added to Approvals/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("reply_proposal");
  });

  it("Copy copies the exact text and says so", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ReplyDrafts laneId="PKG" brief={brief()} tz="America/New_York" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith("Thanks, confirmed.");
  });

  it("nothing for a failed briefing; a reason when drafts are off for the company", () => {
    const { container } = render(<ReplyDrafts laneId="PKG" brief={brief({}, "failed")} tz="America/New_York" />);
    expect(container.textContent).toBe("");
    cleanup();
    render(<ReplyDrafts laneId="PKG" brief={brief({ replies: [], moreReplies: [], notes: ["reply_drafts_off"] })} tz="America/New_York" />);
    expect(screen.getByText(/Reply drafts are off for this company/)).toBeTruthy();
  });
});
