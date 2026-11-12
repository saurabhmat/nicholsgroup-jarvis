import { describe, expect, it } from "vitest";
import { adminHint, ADMIN_HINT_ROLES } from "./hints";
import { FAILURE_CODES, FAILURE_TEXT, classifyFailure, codeForMissingEnv, failureFromNotes, failureNote } from "./failure";

class Named extends Error {
  code: string;
  status?: number;
  constructor(name: string, code = "", status?: number) {
    super("raw provider message sk-ant-SECRET");
    this.name = name;
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

describe("failure reasons", () => {
  it("every code has short text and an admin hint; none contains a value-looking string", () => {
    for (const c of FAILURE_CODES) {
      expect(FAILURE_TEXT[c].length).toBeGreaterThan(3);
      expect(FAILURE_TEXT[c].length).toBeLessThan(50);
      expect(adminHint(c, ["ANTHROPIC_BASE_URL"])).toBeTruthy();
      expect(FAILURE_TEXT[c] + adminHint(c, [])).not.toMatch(/sk-|claude-sonnet/);
    }
    expect(adminHint("model_setting_invalid")).toBe("Check ANTHROPIC_MODEL_ANALYSIS (or the request size)");
    expect(adminHint("sdk_override_set", ["ANTHROPIC_BASE_URL", "evil name"])).toBe("Remove ANTHROPIC_BASE_URL from the environment");
    expect(FAILURE_TEXT.model_setting_invalid).toBe("AI model setting is invalid");
    expect(ADMIN_HINT_ROLES).toEqual(["owner", "admin_technical"]);
  });
  it("round-trips through the notes and ignores unknown codes", () => {
    for (const c of FAILURE_CODES) expect(failureFromNotes(["model_failed", failureNote(c)])).toBe(c);
    expect(failureFromNotes(["fail:made_up", "model_failed"])).toBeNull();
    expect(failureFromNotes([])).toBeNull();
  });
  it("classifies by error class and fixed code only", () => {
    expect(classifyFailure(new Named("LLMProviderError", "invalid_request"))).toBe("model_setting_invalid");
    expect(classifyFailure(new Named("LLMProviderError", "invalid_request", 404))).toBe("model_setting_invalid");
    expect(classifyFailure(new Named("LLMProviderError", "invalid_request", 400))).toBe("provider_error");
    expect(classifyFailure(new Named("LLMProviderError", "unauthorized"))).toBe("key_missing");
    expect(classifyFailure(new Named("LLMProviderError", "timeout"))).toBe("timeout");
    expect(classifyFailure(new Named("LLMProviderError", "aborted"))).toBe("timeout");
    for (const c of ["rate_limited", "overloaded", "connection", "server_error", "unknown"]) expect(classifyFailure(new Named("LLMProviderError", c))).toBe("provider_error");
    expect(classifyFailure(new Named("EnvValidationError"))).toBe("model_setting_invalid");
    expect(classifyFailure(new Named("BriefingOutputError"))).toBe("output_invalid");
    expect(classifyFailure(new Named("BriefingTimeoutError"))).toBe("timeout");
    expect(classifyFailure("weird")).toBe("provider_error");
    expect(classifyFailure(null)).toBe("provider_error");
  });
  it("maps a missing or invalid AI setting to a code from names", () => {
    expect(codeForMissingEnv(["ANTHROPIC_MODEL_ANALYSIS"])).toBe("model_setting_invalid");
    expect(codeForMissingEnv(["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL_FAST"])).toBe("key_missing");
    expect(codeForMissingEnv(["ANTHROPIC_API_KEY"])).toBe("key_missing");
  });
});
