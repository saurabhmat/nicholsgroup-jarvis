// T-234 part 0: the AI setup check returns a fixed code from variable NAMES, trims values, never echoes one.
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { aiSetupFailure } from "./briefing-setup";

const OK = { ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_MODEL_ANALYSIS: "claude-sonnet-5-5", ANTHROPIC_MODEL_FAST: "claude-haiku-5-5" };

describe("aiSetupFailure", () => {
  it("null when configured, including a value with a trailing tab (the production incident)", () => {
    expect(aiSetupFailure(OK)).toBeNull();
    expect(aiSetupFailure({ ...OK, ANTHROPIC_MODEL_ANALYSIS: "claude-sonnet-5-5\t" })).toBeNull();
  });
  it("a bad model id is model_setting_invalid", () => {
    expect(aiSetupFailure({ ...OK, ANTHROPIC_MODEL_ANALYSIS: "claude sonnet" })).toMatchObject({ code: "model_setting_invalid" });
    expect(aiSetupFailure({ ...OK, ANTHROPIC_MODEL_ANALYSIS: "gpt-4" })).toMatchObject({ code: "model_setting_invalid" });
  });
  it("a missing key is key_missing", () => {
    expect(aiSetupFailure({ ...OK, ANTHROPIC_API_KEY: "" })).toMatchObject({ code: "key_missing" });
    expect(aiSetupFailure({})).toMatchObject({ code: "key_missing" });
  });
  it("a refused SDK override is its own code and names the variable", () => {
    const vars = { ...OK, ANTHROPIC_BASE_URL: "https://proxy.example.test" };
    expect(aiSetupFailure(vars)).toEqual({ code: "sdk_override_set", names: ["ANTHROPIC_BASE_URL"] });
  });
});
