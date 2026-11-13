import { describe, expect, it } from "vitest";
import { fieldText, hasPlaceholder, localizeTimes, sentencesText } from "./home-text";

describe("hasPlaceholder", () => {
  it.each([["Pay [amount] today", true], ["Account [number] is late", true], ["[AMOUNT]", true], ["Pay $5 today", false], ["a [note] here", false]])("%s -> %s", (t, v) => expect(hasPlaceholder(t)).toBe(v));
  it("null and undefined are not", () => {
    expect(hasPlaceholder(null)).toBe(false);
    expect(hasPlaceholder(undefined)).toBe(false);
  });
});

describe("fieldText (a one-value field)", () => {
  it("drops the whole field when it holds a placeholder, an empty one too", () => {
    expect(fieldText("Invoice for [amount] is overdue", "America/New_York")).toBeNull();
    expect(fieldText("  ", "America/New_York")).toBeNull();
    expect(fieldText(null, "America/New_York")).toBeNull();
    expect(fieldText("Confirm access", "America/New_York")).toBe("Confirm access");
  });
});

describe("sentencesText (running text)", () => {
  it("drops only the sentences with a placeholder", () => {
    expect(sentencesText("Four meetings today. The invoice is [amount] over budget. Two threads are waiting.", "America/New_York")).toBe("Four meetings today. Two threads are waiting.");
    expect(sentencesText("Only [number] here.", "America/New_York")).toBeNull();
  });
});

describe("localizeTimes", () => {
  it("shows ISO instants in the viewer's zone with no raw ISO and no trailing Z", () => {
    const out = localizeTimes("Due 2026-11-12T14:00:00Z and 2026-07-01T20:30:00.000+00:00", "America/New_York");
    expect(out).toBe("Due Thu, Nov 12, 9:00 AM and Wed, Jul 1, 4:30 PM");
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T|\dZ\b/);
  });
  it("another viewer zone is used; an unknown zone falls back to New York; a bare ISO date is a calendar date without a time-zone shift", () => {
    expect(localizeTimes("2026-11-12T14:00:00Z", "America/Los_Angeles")).toBe("Thu, Nov 12, 6:00 AM");
    expect(localizeTimes("2026-11-12T14:00:00Z", "Not/AZone")).toBe("Thu, Nov 12, 9:00 AM");
    expect(localizeTimes("due 2026-11-13", "America/New_York")).toBe("due Fri, Nov 13");
    expect(localizeTimes("due 2026-11-13.", "America/Los_Angeles")).toBe("due Fri, Nov 13.");
  });
});

describe("localizeTimes (T-237 review)", () => {
  it("leaves a date inside a longer token alone", () => {
    expect(localizeTimes("Invoice INV-2026-11-12 and 2026-11-12-draft, due 2026-11-13", "America/New_York")).toBe("Invoice INV-2026-11-12 and 2026-11-12-draft, due Fri, Nov 13");
    expect(localizeTimes("INV-2026-11-12T14:00:00Z", "America/New_York")).toBe("INV-2026-11-12T14:00:00Z");
  });
  it("a zone-less ISO date-time is New York wall time, shown like the others (no raw ISO)", () => {
    expect(localizeTimes("Call 2026-11-12T14:00:00 now", "America/New_York")).toBe("Call Thu, Nov 12, 2:00 PM now");
    expect(localizeTimes("Call 2026-07-01T14:00:00.", "America/New_York")).toBe("Call Wed, Jul 1, 2:00 PM.");
    expect(localizeTimes("2026-11-12T14:00", "America/Los_Angeles")).toBe("Thu, Nov 12, 11:00 AM");
    expect(localizeTimes("2026-11-12T14:00:00", "America/New_York")).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
