import { describe, expect, it } from "vitest";
import { MODULES } from "@nichols/core/lane-config";
import { MODULE_ID } from "./index";

describe("@nichols/brain", () => {
  it("exposes its module id, and it is a known lane_config module", () => {
    expect(MODULE_ID).toBe("brain");
    expect(MODULES).toContain("brain");
  });
});
