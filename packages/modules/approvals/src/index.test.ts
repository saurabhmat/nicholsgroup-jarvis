import { describe, expect, it } from "vitest";
import { MODULE_ID } from "./index";

describe("@nichols/approvals", () => {
  it("exposes its module id", () => {
    expect(MODULE_ID).toBe("approvals");
  });
});
