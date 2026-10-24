// One-time startup warning for optional-outside-production feature groups. Names only, never values.
// Not `server-only`: instrumentation.ts imports it.
import { isProduction, resolveAnthropicEnv, resolveInngestEnv, type EnvRecord } from "./schema";

let warned = false;

/** Logs at most one warning per process. In production the groups are required (validated elsewhere). */
export function warnUnconfiguredFeatures(env: EnvRecord, log: (message: string) => void = console.warn): void {
  if (warned || isProduction(env)) return;
  warned = true;
  const parts: string[] = [];
  const ai = resolveAnthropicEnv(env);
  if (!ai.configured) parts.push(`AI features not configured: ${ai.missing.join(", ")} missing or invalid`);
  const jobs = resolveInngestEnv(env);
  if (!jobs.configured) parts.push(`Background jobs not configured: ${jobs.missing.join(", ")} missing or invalid`);
  if (parts.length > 0) log(`[env] ${parts.join(". ")}.`);
}
