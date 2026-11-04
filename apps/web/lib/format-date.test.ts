import { describe, expect, it } from "vitest";
import { eyebrowDate } from "./format-date";

describe("eyebrowDate", () => {
  it("formats in the business time zone, not UTC", () => {
    expect(eyebrowDate(new Date("2026-11-30T15:00:00Z"))).toBe("Monday, November 30");
    expect(eyebrowDate(new Date("2026-12-01T02:00:00Z"))).toBe("Monday, November 30"); // 9 pm ET still Monday
  });
});
