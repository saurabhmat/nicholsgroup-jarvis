import { describe, expect, it } from "vitest";
import { commitmentNotice, commitmentsToCheck, etDate, etDateTime, findCommitments, savedLabel, senderName, stripPlaceholders, threadTime } from "./reply-text";

describe("stripPlaceholders", () => {
  it("drops the sentence with a placeholder and counts the line", () => {
    const r = stripPlaceholders("Hi,\n\nThanks. The fee is [amount] per month. Talk soon.\n\nBest");
    expect(r.text).toBe("Hi,\n\nThanks. Talk soon.\n\nBest");
    expect(r.removed).toBe(1);
  });
  it("removes a line that only held the placeholder, with no leftover blank gap", () => {
    const r = stripPlaceholders("Hi\nInvoice [number] is open.\nBest");
    expect(r.text).toBe("Hi\nBest");
    expect(r.removed).toBe(1);
  });
  it("returns text without a token exactly as it was (no trim, no line-ending change)", () => {
    const t = "  Hi,\r\n\r\nAll good.   \r\n";
    expect(stripPlaceholders(t)).toEqual({ text: t, removed: 0 });
  });
  it("keeps CRLF line endings when it removes a sentence", () => {
    const r = stripPlaceholders("Hi,\r\n\r\nThanks. The fee is [amount] a month. Talk soon.\r\nBest");
    expect(r.text).toBe("Hi,\r\n\r\nThanks. Talk soon.\r\nBest");
    expect(r.text.includes("\n\n")).toBe(false);
    expect(r.removed).toBe(1);
  });
  it("does not split after an abbreviation: 'Mr. Smith owes [amount].' goes whole", () => {
    const r = stripPlaceholders("Hello. Mr. Smith owes [amount]. Thanks.");
    expect(r.text).toBe("Hello. Thanks.");
    expect(r.removed).toBe(1);
  });
  it("uses no regex lookbehind (older Safari cannot parse it)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./reply-text.ts", import.meta.url), "utf8");
    expect(src.includes("(?<=") || src.includes("(?<!")).toBe(false);
  });
  it("leaves clean text alone and never leaves a token", () => {
    expect(stripPlaceholders("All good.")).toEqual({ text: "All good.", removed: 0 });
    expect(/\[(amount|number)\]/i.test(stripPlaceholders("Pay [AMOUNT] by card [number].").text)).toBe(false);
  });
});

describe("findCommitments", () => {
  it("finds days, times, dates and promises", () => {
    expect(findCommitments("will confirm by Thursday noon ET, ahead of Friday's call")).toEqual(["Thursday noon ET"]);
    expect(findCommitments("I'll get it to you tomorrow")).toContain("tomorrow");
    expect(findCommitments("Expect it by end of day.")).toContain("end of day");
    expect(findCommitments("Done by Nov 14 at 3pm ET")).toContain("Nov 14 at 3pm ET");
    expect(findCommitments("We reply within 2 business days")).toContain("within 2 business days");
    expect(findCommitments("We will send the files")).toContain("We will send");
    expect(findCommitments("We'll confirm soon")).toContain("We'll confirm");
  });
  it("finds nothing in plain text", () => {
    expect(findCommitments("Thanks for flagging this. Could you send the addresses?")).toEqual([]);
  });
});

describe("findCommitments: possessives", () => {
  it("does not flag a day followed by 's", () => {
    expect(findCommitments("Let's talk before Friday's call")).toEqual([]);
    expect(findCommitments("see you on Monday\u2019s call")).toEqual([]);
    expect(findCommitments("tomorrow's agenda")).toEqual([]);
    expect(findCommitments("We will confirm before Friday.")).toContain("Friday");
  });
});

describe("commitmentsToCheck", () => {
  const ai = "We will confirm by Thursday noon ET.";
  it("flags a phrase from the AI draft that is still in the body", () => {
    expect(commitmentsToCheck(ai, ai)).toEqual(["Thursday noon ET", "We will confirm"]);
  });
  it("is hidden when the user removed it", () => {
    expect(commitmentsToCheck("We will look into it.", ai)).toEqual([]);
  });
  it("does not flag text the user typed", () => {
    expect(commitmentsToCheck("Thanks. Done by Friday.", "Thanks.")).toEqual([]);
    expect(commitmentsToCheck("Thanks. Done by Friday.", "")).toEqual([]);
  });
  it("flags an AI phrase that survives next to the user's own", () => {
    expect(commitmentsToCheck("Hello. We will confirm by Thursday noon ET. I will call tomorrow.", ai)).toEqual(["Thursday noon ET", "We will confirm"]);
  });
  it("lists every distinct AI commitment still present", () => {
    const two = "I'll confirm by Thursday noon ET and send it within 2 days.";
    expect(commitmentsToCheck(two, two)).toEqual(["Thursday noon ET", "within 2 days", "I'll confirm"]);
    expect(commitmentsToCheck("Okay, within 2 days.", two)).toEqual(["within 2 days"]);
  });
  it("works with CRLF text", () => {
    expect(commitmentsToCheck("Hi,\r\nBy Friday noon.\r\nBest", "Hi,\r\nBy Friday noon.\r\nBest")).toEqual(["Friday noon"]);
  });
});

describe("commitmentNotice", () => {
  it("one or several phrases, one notice", () => {
    expect(commitmentNotice([])).toBeNull();
    expect(commitmentNotice(["A"])).toBe('Check before sending: "A" is a commitment Jarvis suggested.');
    expect(commitmentNotice(["A", "B"])).toBe('Check before sending: "A", "B" are commitments Jarvis suggested.');
  });
});

describe("display strings", () => {
  it("savedLabel", () => {
    expect(savedLabel(null, 5)).toBeNull();
    expect(savedLabel(1000, 20_000)).toBe("Saved just now");
    expect(savedLabel(0, 3 * 60_000 + 5)).toBe("Saved 3 min ago");
  });
  it("senderName", () => {
    expect(senderName("Dana Example <dana@example.test>")).toBe("Dana Example");
    expect(senderName("dana@example.test")).toBe("dana@example.test");
    expect(senderName("Unknown sender")).toBeNull();
    expect(senderName('"Dana E" <d@example.test>')).toBe("Dana E");
    expect(senderName("<d@example.test>")).toBeNull();
  });
  it("senderName is fast on hostile input", () => {
    const t0 = Date.now();
    senderName(`${"a <".repeat(50_000)}x`);
    senderName(`${" ".repeat(100_000)}<`);
    expect(Date.now() - t0).toBeLessThan(200);
  });
  it("etDate and etDateTime are Eastern with ET", () => {
    expect(etDate("2026-11-10T03:30:00Z")).toBe("Nov 9, 2026 ET");
    expect(etDateTime("2026-11-14T12:00:00Z")).toBe("Nov 14, 2026, 7:00 AM ET");
    expect(etDate("nope")).toBeNull();
    expect(etDateTime("")).toBeNull();
  });
  it("threadTime is Eastern with ET and no Z", () => {
    expect(threadTime("2026-11-10T21:12:00Z")).toBe("Tue, Nov 10, 4:12 PM ET");
    expect(threadTime("2026-07-10T20:12:00Z")).toBe("Fri, Jul 10, 4:12 PM ET");
    expect(threadTime("")).toBeNull();
    expect(threadTime("nope")).toBeNull();
  });
});
