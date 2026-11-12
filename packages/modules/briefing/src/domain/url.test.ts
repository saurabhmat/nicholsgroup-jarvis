import { describe, expect, it } from "vitest";
import { httpsUrl } from "./url";

describe("httpsUrl", () => {
  it.each([
    "https://meet.google.com@evil.test/x",
    "https://a:b@evil.test",
    "https://user@evil.test",
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<b>x</b>",
    "http://meet.google.com/abc",
    "not a url",
    "",
  ])("rejects %s", (v) => {
    expect(httpsUrl(v)).toBeNull();
  });
  it("rejects non-strings", () => {
    expect(httpsUrl(null)).toBeNull();
    expect(httpsUrl(42)).toBeNull();
  });
  it("returns the normalised href for a valid https URL", () => {
    expect(httpsUrl("HTTPS://Meet.Google.com/abc-defg?x=1")).toBe("https://meet.google.com/abc-defg?x=1");
    expect(httpsUrl("https://meet.google.com")).toBe("https://meet.google.com/");
  });
});
