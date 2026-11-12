// Whether the AI is set up for this deployment, as a fixed failure code (T-234 part 0). Reads the validated Anthropic group
// (trimmed, model ids checked) and reports variable NAMES only through a code; never a value.
import { getLLMProvider } from "@nichols/ai/config";
import { classifyFailure, codeForMissingEnv, type FailureCode } from "@nichols/briefing/domain";

export type AiSetupFailure = { code: FailureCode; /** Refused SDK override variable names (sdk_override_set only). */ names: string[] };

/** null when the AI is configured; otherwise why not. Never throws. */
export function aiSetupFailure(env?: Record<string, string | undefined>): AiSetupFailure | null {
  try {
    const p = env ? getLLMProvider({ env }) : getLLMProvider();
    if (p.configured) return null;
    if (p.refused.length > 0) return { code: "sdk_override_set", names: p.refused };
    return { code: codeForMissingEnv(p.missing), names: [] };
  } catch (e) {
    return { code: classifyFailure(e), names: [] };
  }
}
