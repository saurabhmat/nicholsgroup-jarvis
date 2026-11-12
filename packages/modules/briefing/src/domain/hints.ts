// Admin-only hints for a briefing failure (T-234). Kept apart from failure.ts so client components never import them: the
// server computes the hint and passes it as a prop only to admins (owner, admin_technical). Names only, never a value.
import type { FailureCode } from "./failure";

export const ADMIN_HINT_ROLES = ["owner", "admin_technical"] as const;

const HINTS: Readonly<Record<Exclude<FailureCode, "sdk_override_set">, string>> = {
  model_setting_invalid: "Check ANTHROPIC_MODEL_ANALYSIS (or the request size)",
  key_missing: "Check ANTHROPIC_API_KEY in the environment",
  model_not_allowed: "Check the AI categories in this company's lane policy (email, calendar)",
  timeout: "The AI provider did not answer in time; it retries on the next Home visit or with Regenerate",
  provider_error: "Check the AI provider status and ANTHROPIC_API_KEY",
  output_truncated: "The reply was cut off at the output limit twice (the retry used 1.5x); raise briefing.max_tokens in lane_config. See briefing.model_call in the server log (codes only)",
  output_invalid: "The model's reply was not the expected format after one automatic retry; see the server log briefing.model_output_invalid (codes only)",
};

const OVERRIDE_NAME = /^ANTHROPIC_[A-Z0-9_]{1,60}$/;

/** `names`: the refused SDK override variables (sdk_override_set only); anything not shaped like a variable name is dropped. */
export function adminHint(code: FailureCode, names: readonly string[] = []): string {
  if (code === "sdk_override_set") {
    const ok = names.filter((n) => OVERRIDE_NAME.test(n));
    return ok.length > 0 ? `Remove ${ok.join(", ")} from the environment` : "Remove the ANTHROPIC_* override variables from the environment";
  }
  return HINTS[code];
}
