import { getAnthropicEnv } from "@nichols/core/env/server";
import { createAnthropicProvider } from "./anthropic";
import type { LLMLogger, LLMProvider } from "./types";

export type ProviderResult =
  | { configured: true; provider: LLMProvider }
  /** `refused`: SDK override variables that must be unset (ANTHROPIC_BASE_URL, ANTHROPIC_LOG, …). */
  | { configured: false; missing: string[]; refused: string[] };

/**
 * Builds the provider from ANTHROPIC_API_KEY / ANTHROPIC_MODEL_ANALYSIS / ANTHROPIC_MODEL_FAST. When the group is not
 * configured (local/preview) it reports `configured:false` and callers switch the AI feature off.
 */
export function getLLMProvider(
  opts: { env?: Record<string, string | undefined>; logger?: LLMLogger; maxRetries?: number; timeoutMs?: number } = {},
): ProviderResult {
  const { env, logger, maxRetries, timeoutMs } = opts;
  const cfg = env ? getAnthropicEnv(env) : getAnthropicEnv();
  if (!cfg.configured) return { configured: false, missing: cfg.missing, refused: "refused" in cfg && Array.isArray(cfg.refused) ? cfg.refused.map(String) : [] };
  return {
    configured: true,
    provider: createAnthropicProvider({
      apiKey: cfg.ANTHROPIC_API_KEY,
      models: { analysis: cfg.ANTHROPIC_MODEL_ANALYSIS, fast: cfg.ANTHROPIC_MODEL_FAST },
      ...(logger ? { logger } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }),
  };
}
