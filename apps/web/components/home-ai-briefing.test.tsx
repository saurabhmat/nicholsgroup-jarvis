// @vitest-environment jsdom
// T-234 part 2 / T-235 part 1: the top of "Needs your attention": AI summary, "Summary at" line, the owner's controls slot (no Run button), Top 3 row; the rule-based fallback with the
// fixed reason; the admin hint only when the server passed one.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { SavedBriefingView } from "@/lib/briefing";

import { AiBriefing, Deadlines, repliesByMessage } from "./home-ai-briefing";

afterEach(cleanup);
const ref = { ref: "r1", connectionId: "c1", messageId: "m1", threadKey: "t1", mailbox: "me@pubk.test", fromAddress: "p@acme.test", fromName: "P", subject: "Renewal", receivedAt: "2026-11-11T10:00:00Z", sourceUrl: "https://mail.google.com/x", reason: "r", kind: "waiting" };
const brief = (over: Partial<SavedBriefingView["content"]> = {}, status: SavedBriefingView["status"] = "ready"): SavedBriefingView => ({
  id: "b1", status, trigger: "manual", preparedAt: "2026-11-11T12:00:00Z", windowFrom: "2026-11-10T12:00:00Z", windowTo: "2026-11-11T12:00:00Z", lastFailedAt: null, lastRunAt: null, refs: [ref],
  content: { lines: ["First sentence.", "Second sentence.", "Third line."], attention: [], deadlines: [{ text: "Send the plan", due: "2026-11-14", ref: "r1" }], priorities: [{ text: "Confirm renewal", reason: "Due Friday", refs: [] }, { text: "Review plan", reason: "x", refs: [] }, { text: "Call Ann", reason: "y", refs: [] }], replies: [{ ref: "r1", status: "ready", context: "", text: "ok", proposalId: "00000000-0000-4000-8000-0000000000d1" }], moreReplies: [], notes: [], ...over },
});
const base = { laneId: "PKG", fallbackLines: ["Rule-based: 2 unread."], tz: "America/New_York", now: new Date("2026-11-11T20:00:00Z") };

describe("T-237: placeholders and raw times are never shown", () => {
  const PH = /\[(amount|number)\]/;
  it("a summary sentence holding a placeholder is dropped; a line that is only a placeholder sentence disappears", () => {
    render(<AiBriefing {...base} brief={brief({ lines: ["Four meetings today. The invoice is [amount] over budget. Two threads wait.", "Account [number] is overdue."] })} />);
    expect(screen.getByTestId("briefing").textContent).toBe("Four meetings today. Two threads wait.");
    expect(document.body.textContent).not.toMatch(PH);
  });
  it("priorities: one holding a placeholder is dropped, a reason holding one is hidden, the rest stays", () => {
    render(<AiBriefing {...base} brief={brief({ priorities: [{ text: "Pay [amount] now", reason: "r", refs: [] }, { text: "Call Ann", reason: "Owes [number]", refs: [] }, { text: "Review plan", reason: "Due Friday", refs: [] }] })} />);
    const items = within(screen.getByTestId("priorities")).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["Call Ann", "Review plan \u2013 Due Friday"]);
    expect(document.body.textContent).not.toMatch(PH);
  });
  it("if every AI line holds a placeholder the rule-based sentences stand in; with none of those either, no empty paragraph", () => {
    render(<AiBriefing {...base} brief={brief({ lines: ["All [amount] gone."], priorities: [] })} />);
    expect(screen.getByTestId("briefing").textContent).toBe("Rule-based: 2 unread.");
  });
  it("deadlines: an item whose text holds a placeholder is dropped, a due text with one is hidden, ISO times and dates are shown as New York time", () => {
    render(<Deadlines laneId="PKG" tz="America/New_York" brief={brief({ deadlines: [{ text: "Pay [amount]", due: null, ref: "r1" }, { text: "Send the plan", due: "2026-11-14", ref: "r1" }, { text: "Sign", due: "about [number]", ref: null }, { text: "Call", due: "2026-11-13T14:00:00Z", ref: null }] })} />);
    const items = within(screen.getByTestId("deadlines")).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain("Send the plan \u00b7 due Sat, Nov 14");
    expect(items[1]?.textContent).toBe("Sign"); // the due text with a placeholder is hidden, the item stays
    expect(items[2]?.textContent).toBe("Call \u00b7 due Fri, Nov 13, 9:00 AM");
    expect(document.body.textContent).not.toMatch(PH);
    expect(document.body.textContent).not.toMatch(/\dZ\b|T14:00/);
  });
});

describe("AiBriefing: Today at a glance (T-235 part 2)", () => {
  it("is a cream panel with a 3px gold left edge, titled 'Today at a glance'", () => {
    render(<AiBriefing {...base} brief={brief()} />);
    const panel = screen.getByTestId("ai-briefing");
    expect(panel.className).toMatch(/border-l-\[3px\]/);
    expect(panel.className).toMatch(/border-l-gold/);
    expect(panel.className).toMatch(/bg-background/); // the cream ground token (AA pairs for muted text are in tokens.test.ts, light and dark)
    expect(within(panel).getByRole("heading", { name: "Today at a glance" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Today at a glance" })).toBe(panel);
  });

  it("shows at most three sentences, the rest behind 'More from the briefing', 'Summary at <time>' and no Run button", () => {
    render(<AiBriefing {...base} brief={brief({ lines: ["One.", "Two.", "Three.", "Four.", "Five."] })} />);
    expect(screen.getByTestId("briefing").textContent).toBe("One. Two. Three.");
    const more = screen.getByTestId("briefing-more");
    expect(within(more).getByText("Four.")).toBeTruthy();
    expect(within(more).getByText("Five.")).toBeTruthy();
    expect(screen.getByTestId("briefing-prepared").textContent).toBe("Summary at 7:00 AM");
    expect(screen.queryByText("Run now")).toBeNull();
  });

  it("with three lines or fewer there is no 'More' disclosure", () => {
    render(<AiBriefing {...base} brief={brief()} />);
    expect(screen.getByTestId("briefing").textContent).toBe("First sentence. Second sentence. Third line.");
    expect(screen.queryByTestId("briefing-more")).toBeNull();
  });

  it("Top priorities: a numbered list of three, the action bold and the reason muted", () => {
    render(<AiBriefing {...base} brief={brief({ priorities: [{ text: "A", reason: "r1", refs: [] }, { text: "B", reason: "r2", refs: [] }, { text: "C", reason: "r3", refs: [] }, { text: "D", reason: "r4", refs: [] }] })} />);
    const row = screen.getByTestId("priorities-row");
    expect(within(row).getByRole("heading", { name: "Top priorities" })).toBeTruthy();
    const list = within(row).getByTestId("priorities");
    expect(list.tagName).toBe("OL");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.textContent)).toEqual(["A \u2013 r1", "B \u2013 r2", "C \u2013 r3"]);
    const bold = items[0]?.querySelector("span.font-semibold");
    expect(bold?.textContent).toBe("A");
    const muted = items[0]?.querySelector("span.text-muted-foreground");
    expect(muted?.textContent).toBe(" \u2013 r1");
  });

  it("AI unavailable: the rule-based sentences (at most two) and exactly ONE muted reason line, no Top priorities", () => {
    render(<AiBriefing {...base} fallbackLines={["Rule one.", "Rule two.", "Rule three."]} brief={null} failure="key_missing" />);
    expect(screen.getByTestId("briefing").textContent).toBe("Rule one. Rule two.");
    const lines = screen.getAllByTestId("briefing-failure");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toMatch(/^AI summary unavailable: /);
    expect(lines[0]?.className).toMatch(/text-muted-foreground/);
    expect(screen.queryByTestId("priorities")).toBeNull();
    expect(screen.queryByTestId("briefing-last-failed")).toBeNull();
  });

  it("a failed newest attempt: still one reason line", () => {
    render(<AiBriefing {...base} brief={brief({ lines: [], priorities: [] }, "failed")} failure="timeout" />);
    expect(screen.getByTestId("briefing").textContent).toBe("Rule-based: 2 unread.");
    expect(screen.getAllByTestId("briefing-failure")).toHaveLength(1);
    expect(screen.getByTestId("briefing-failure").textContent).toMatch(/^AI summary unavailable: /);
  });

  it("a good briefing plus a newer failure: one muted line, never the failure line and the 'newer attempt' line together", () => {
    render(<AiBriefing {...base} brief={{ ...brief(), lastFailedAt: "2026-11-11T13:00:00Z" }} failure="timeout" />);
    expect(screen.getAllByTestId("briefing-failure")).toHaveLength(1);
    expect(screen.queryByTestId("briefing-last-failed")).toBeNull();
    cleanup();
    render(<AiBriefing {...base} brief={{ ...brief(), lastFailedAt: "2026-11-11T13:00:00Z" }} />);
    expect(screen.queryByTestId("briefing-failure")).toBeNull();
    expect(screen.getByTestId("briefing-last-failed")).toBeTruthy();
  });

  it("the admin hint renders only when the server passed one, continuing the same single muted line", () => {
    const { rerender } = render(<AiBriefing {...base} brief={null} failure="key_missing" />);
    expect(screen.queryByTestId("briefing-failure-hint")).toBeNull();
    rerender(<AiBriefing {...base} brief={null} failure="key_missing" failureHint="Set ANTHROPIC_API_KEY" />);
    expect(screen.getByTestId("briefing-failure-hint").textContent).toBe(" · Set ANTHROPIC_API_KEY");
    expect(screen.getAllByTestId("briefing-failure")).toHaveLength(1);
  });

  it("the summary time is today's clock time, or the date and time on another day, in the viewer's zone", () => {
    const { rerender } = render(<AiBriefing {...base} brief={brief()} />);
    expect(screen.getByTestId("briefing-prepared").textContent).toBe("Summary at 7:00 AM");
    rerender(<AiBriefing {...base} now={new Date("2026-11-12T20:00:00Z")} brief={brief()} />);
    expect(screen.getByTestId("briefing-prepared").textContent).toBe("Summary at Nov 11, 7:00 AM");
  });

  it("the owner's controls render inside the panel next to the time; without them (a non-owner) there are none", () => {
    const { rerender } = render(<AiBriefing {...base} brief={brief()} controls={<span data-testid="ctl">controls</span>} />);
    expect(within(screen.getByTestId("ai-briefing")).getByTestId("ctl")).toBeTruthy();
    rerender(<AiBriefing {...base} brief={brief()} />);
    expect(screen.queryByTestId("ctl")).toBeNull();
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
