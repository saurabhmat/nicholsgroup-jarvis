import { describe, expect, it } from "vitest";
import { cn, isSafeEmail, mailtoHref } from "./utils";

describe("cn", () => {
  it("merges conflicting Tailwind classes, last one wins", () => {
    expect(cn("px-2 text-sm", "px-4")).toBe("text-sm px-4");
  });

  it("knows the type scale: sizes merge with each other, not with colours", () => {
    expect(cn("text-body text-card-foreground")).toBe("text-body text-card-foreground");
    expect(cn("text-card-title text-muted-foreground")).toBe("text-card-title text-muted-foreground");
    expect(cn("text-body", "text-small")).toBe("text-small");
    expect(cn("text-sm", "text-page-title")).toBe("text-page-title");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, undefined, null, "b")).toBe("a b");
  });
});

describe("isSafeEmail", () => {
  it("accepts a plain address", () => {
    expect(isSafeEmail("it@pub-k.org")).toBe(true);
  });

  it.each([
    "",
    "not-an-email",
    "a@b",
    "it@pub-k.org?bcc=x@evil.test",
    "it@pub-k.org\r\nBcc: x@evil.test",
    "javascript:alert(1)@x.org",
    "a b@pub-k.org",
    // Percent-encoded payloads: mail clients decode these.
    "attacker%40evil.test%2Cit@pub-k.org",
    "it%0A@pub-k.org",
    "it%0D%0ABcc%3Ax@pub-k.org",
    "it%2Cx@pub-k.org",
    "it%3Fcc%3Dx@pub-k.org",
    "it%40x@pub-k.org",
  ])("rejects %j", (value) => {
    expect(isSafeEmail(value)).toBe(false);
  });
});

describe("mailtoHref", () => {
  it("builds a mailto link", () => {
    expect(mailtoHref("it@pub-k.org")).toBe("mailto:it@pub-k.org");
  });

  it("encodes the subject", () => {
    expect(mailtoHref("it@pub-k.org", "Sync failed & retry")).toBe(
      "mailto:it@pub-k.org?subject=Sync%20failed%20%26%20retry",
    );
  });

  it("strips control characters from the subject", () => {
    expect(mailtoHref("it@pub-k.org", "a\r\nBcc: x@evil.test\u0000\u007f")).toBe(
      "mailto:it@pub-k.org?subject=aBcc%3A%20x%40evil.test",
    );
  });

  it("caps the subject at 200 characters", () => {
    const href = mailtoHref("it@pub-k.org", "x".repeat(500));
    expect(href).toBe(`mailto:it@pub-k.org?subject=${"x".repeat(200)}`);
  });

  it("omits an empty subject", () => {
    expect(mailtoHref("it@pub-k.org", "\r\n")).toBe("mailto:it@pub-k.org");
  });

  it("returns undefined for an unsafe address", () => {
    expect(mailtoHref("x@y.org?cc=z@evil.test")).toBeUndefined();
  });
});
