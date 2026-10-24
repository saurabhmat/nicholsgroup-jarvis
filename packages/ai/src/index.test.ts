import { describe, expect, it } from "vitest";
import { PACKAGE_ID } from "./index";

describe("@nichols/ai", () => {
  it("exposes its package id", () => {
    expect(PACKAGE_ID).toBe("ai");
  });
});
