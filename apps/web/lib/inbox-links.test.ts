import { describe, expect, it } from "vitest";
import { inboxHref } from "./inbox-links";

describe("inboxHref", () => {
  it("is the Jarvis thread route for the lane, with the id as one encoded segment", () => {
    expect(inboxHref("PKG", "18c2f0a1b2c3d4e5")).toBe("/PKG/inbox/18c2f0a1b2c3d4e5");
    expect(inboxHref("PKG", "a/b?c")).toBe("/PKG/inbox/a%2Fb%3Fc");
  });
  it("is never a Google URL", () => {
    expect(inboxHref("PKG", "x")).not.toMatch(/google/);
  });
});
