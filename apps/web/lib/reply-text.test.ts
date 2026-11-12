import { describe, expect, it } from "vitest";
import { commitmentToCheck, findCommitments, savedLabel, senderName, stripPlaceholders, threadTime } from "./reply-text";

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

describe("commitmentToCheck", () => {
  const ai = "We will confirm by Thursday noon ET.";
  it("flags a phrase from the AI draft that is still in the body", () => {
    expect(commitmentToCheck(ai, ai)).toBe("Thursday noon ET");
  });
  it("is hidden when the user removed it", () => {
    expect(commitmentToCheck("We will look into it.", ai)).toBeNull();
  });
  it("does not flag text the user typed", () => {
    expect(commitmentToCheck(`${ai}\nI can also call tomorrow.`.replace(ai, "Thanks."), ai)).toBeNull();
    expect(commitmentToCheck("Thanks. Done by Friday.", "Thanks.")).toBeNull();
  });
  it("flags an AI phrase that survives next to the user's own", () => {
    expect(commitmentToCheck("Hello. We will confirm by Thursday noon ET. I will call tomorrow.", ai)).toBe("Thursday noon ET");
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
  });
  it("threadTime is Eastern with ET and no Z", () => {
    expect(threadTime("2026-11-10T21:12:00Z")).toBe("Tue, Nov 10, 4:12 PM ET");
    expect(threadTime("2026-07-10T20:12:00Z")).toBe("Fri, Jul 10, 4:12 PM ET");
    expect(threadTime("")).toBeNull();
    expect(threadTime("nope")).toBeNull();
  });
});
