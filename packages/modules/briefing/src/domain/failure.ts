// Why a briefing could not be prepared (T-234 part 0). A FIXED set of codes mapped to short user text and an admin-only
// hint. Codes and hints name variables and settings only: never an environment value, a provider message or a secret.
// The code is stored as a note "fail:<code>" in the briefing's content.notes (codes only).

export const FAILURE_CODES = ["model_setting_invalid", "key_missing", "model_not_allowed", "timeout", "provider_error", "output_invalid", "sdk_override_set"] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export const FAILURE_TEXT: Readonly<Record<FailureCode, string>> = {
  model_setting_invalid: "AI model setting is invalid",
  key_missing: "AI key missing",
  model_not_allowed: "Model not allowed by policy",
  timeout: "Timed out",
  provider_error: "Provider error",
  output_invalid: "The AI reply could not be read",
  sdk_override_set: "AI provider override is set",
};

const PREFIX = "fail:";
export const failureNote = (code: FailureCode): string => `${PREFIX}${code}`;

/** The failure code recorded in a briefing's notes, or null. Unknown codes are ignored (the set is closed). */
export function failureFromNotes(notes: readonly string[]): FailureCode | null {
  for (const n of notes) {
    if (!n.startsWith(PREFIX)) continue;
    const code = n.slice(PREFIX.length);
    if ((FAILURE_CODES as readonly string[]).includes(code)) return code as FailureCode;
  }
  return null;
}


/**
 * Maps a thrown error to a code. Only the error's class and its fixed `code` field are read (LLMProviderError carries a
 * fixed code per kind; vendor messages are never looked at).
 */
export function classifyFailure(e: unknown): FailureCode {
  const name = e instanceof Error ? e.name : "";
  const code = typeof (e as { code?: unknown } | null)?.code === "string" ? (e as { code: string }).code : "";
  if (name === "EnvValidationError") return "model_setting_invalid";
  if (name === "LLMProviderError") {
    if (code === "unauthorized") return "key_missing";
    if (code === "invalid_request") {
      // The provider's HTTP status, when it carries one: 404 = unknown model; any other 4xx is not the model setting.
      const status = (e as { status?: unknown }).status;
      return typeof status === "number" && status !== 404 ? "provider_error" : "model_setting_invalid";
    }
    if (code === "timeout" || code === "aborted") return "timeout";
    return "provider_error";
  }
  if (name === "BriefingOutputError") return "output_invalid";
  if (name === "BriefingTimeoutError") return "timeout";
  return "provider_error";
}

/** Which code a "not configured" AI group means, from the variable NAMES reported missing or invalid. */
export function codeForMissingEnv(missing: readonly string[]): FailureCode {
  return missing.some((n) => n.startsWith("ANTHROPIC_MODEL_")) && !missing.includes("ANTHROPIC_API_KEY") ? "model_setting_invalid" : "key_missing";
}
