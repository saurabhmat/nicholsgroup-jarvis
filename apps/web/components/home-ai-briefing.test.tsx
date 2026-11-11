// @vitest-environment jsdom
// T-234 part 2: the top of "Needs your attention": AI summary, prepared line, Run now, Top 3 row; the rule-based fallback with the
// fixed reason; the admin hint only when the server passed one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { SavedBriefingView } from "@/lib/briefing";

vi.mock("@/app/[laneId]/briefing-actions", () => ({ runBriefingNow: async () => null }));
import { AiBriefing, Deadlines, repliesByMessage } from "./home-ai-briefing";

afterEach(cleanup);
const ref = { ref: "r1", connectionId: "c1", messageId: "m1", threadKey: "t1", mailbox: "me@pubk.test", fromAddress: "p@acme.test", fromName: "P", subject: "Renewal", receivedAt: "2026-11-11T10:00:00Z", sourceUrl: "https://mail.google.com/x", reason: "r", kind: "waiting" };
const brief = (over: Partial<SavedBriefingView["content"]> = {}, status: SavedBriefingView["status"] = "ready"): SavedBriefingView => ({
  id: "b1", status, trigger: "manual", preparedAt: "2026-11-11T12:00:00Z", windowFrom: "2026-11-10T12:00:00Z", windowTo: "2026-11-11T12:00:00Z", lastFailedAt: null, lastRunAt: null, refs: [ref],
  content: { lines: ["First sentence.", "Second sentence.", "Third line."], attention: [], deadlines: [{ text: "Send the plan", due: "2026-11-14", ref: "r1" }], priorities: [{ text: "Confirm renewal", reason: "Due Friday", refs: [] }, { text: "Review plan", reason: "x", refs: [] }, { text: "Call Ann", reason: "y", refs: [] }], replies: [{ ref: "r1", status: "ready", context: "", text: "ok", proposalId: "00000000-0000-4000-8000-0000000000d1" }], moreReplies: [], notes: [], ...over },
});
const base = { laneId: "PKG", fallbackLines: ["Rule-based: 2 unread."], tz: "America/New_York", canRun: true };

describe("AiBriefing", () => {
  it("shows a 1-2 sentence summary, the prepared line with Run now, and Top 3 as a numbered row", () => {
    render(<AiBriefing {...base} brief={brief()} />);
    expect(screen.getByTestId("briefing").textContent).toBe("First sentence. Second sentence.");
    expect(within(screen.getByTestId("briefing-more")).getByText("Third line.")).toBeTruthy();
    expect(screen.getByTestId("briefing-prepared").textContent).toBe("Prepared at Wed, Nov 11, 7:00 AM");
    expect(screen.getByTestId("run-briefing")).toBeTruthy();
    const items = within(screen.getByTestId("priorities")).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["1.Confirm renewal", "2.Review plan", "3.Call Ann"]);
    expect(screen.queryByTestId("briefing-failure")).toBeNull();
  });

  it("without an AI briefing: the rule-based sentence and 'AI summary unavailable: <reason>', no Top 3", () => {
    render(<AiBriefing {...base} brief={null} failure="key_missing" />);
    expect(screen.getByTestId("briefing").textContent).toBe("Rule-based: 2 unread.");
    expect(screen.getByTestId("briefing-failure").textContent).toMatch(/^AI summary unavailable: /);
    expect(screen.queryByTestId("priorities")).toBeNull();
  });

  it("a failed newest attempt shows the rule-based list and the reason", () => {
    render(<AiBriefing {...base} brief={brief({ lines: [], priorities: [] }, "failed")} failure="timeout" />);
    expect(screen.getByTestId("briefing").textContent).toBe("Rule-based: 2 unread.");
    expect(screen.getByTestId("briefing-failure").textContent).toMatch(/^AI summary unavailable: /);
  });

  it("the admin hint renders only when the server passed one", () => {
    const { rerender } = render(<AiBriefing {...base} brief={null} failure="key_missing" />);
    expect(screen.queryByTestId("briefing-failure-hint")).toBeNull();
    rerender(<AiBriefing {...base} brief={null} failure="key_missing" failureHint="Set ANTHROPIC_API_KEY" />);
    expect(screen.getByTestId("briefing-failure-hint").textContent).toBe("Set ANTHROPIC_API_KEY");
  });

  it("no Run now for a caller who cannot run it", () => {
    render(<AiBriefing {...base} canRun={false} brief={brief()} />);
    expect(screen.queryByTestId("run-briefing")).toBeNull();
  });
});

describe("Deadlines and repliesByMessage", () => {
  it("deadline sources open the thread in Jarvis, not Google", () => {
    render(<Deadlines laneId="PKG" brief={brief()} tz="America/New_York" />);
    const links = screen.getAllByRole("link", { name: "Open thread" });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/PKG/inbox/m1"]);
  });
  it("maps provider messages to their prepared proposal", () => {
    expect([...repliesByMessage(brief())]).toEqual([["c1:m1", "00000000-0000-4000-8000-0000000000d1"]]);
    expect(repliesByMessage(null).size).toBe(0);
    expect(repliesByMessage(brief({}, "failed")).size).toBe(0);
  });
});
