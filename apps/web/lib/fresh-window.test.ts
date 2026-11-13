import { describe, expect, it } from "vitest";
import { freshWindowText } from "./fresh-window";

describe("freshWindowText", () => {
  it.each([
    [48, "2 days"],
    [72, "3 days"],
    [168, "7 days"],
    [24, "24 hours"],
    [36, "36 hours"],
    [6, "6 hours"],
    [50, "50 hours"],
  ])("%i -> %s", (h, text) => expect(freshWindowText(h)).toBe(text));
});
