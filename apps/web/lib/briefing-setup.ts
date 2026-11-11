// Whether the AI is set up for this deployment, as a fixed failure code (T-234 part 0). Reads the validated Anthropic group
// (trimmed, model ids checked) and reports variable NAMES only through a code; never a value.
import { getLLMProvider } from "@nichols/ai/config";
import { classifyFailure, codeForMissingEnv, type FailureCode } from "@nichols/briefing/domain";

/** null when the AI is configured; otherwise why not. Never throws. */
export function aiSetupFailure(env?: Record<string, string | undefined>): FailureCode | null {
  try {
    const p = env ? getLLMProvider({ env }) : getLLMProvider();
    return p.configured ? null : codeForMissingEnv(p.missing);
  } catch (e) {
    return classifyFailure(e);
  }
}
