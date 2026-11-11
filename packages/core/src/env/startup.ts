// One-time startup warning for optional feature groups. Names only, never values.
// Not `server-only`: instrumentation.ts imports it.
import { resolveAnthropicEnv, resolveInngestEnv, type EnvRecord } from "./schema";

let warned = false;

/**
 * Logs at most one warning per process. In production a partial group already failed the build and boot, so here
 * it only reports groups that are entirely absent.
 */
export function warnUnconfiguredFeatures(env: EnvRecord, log: (message: string) => void = console.warn): void {
  if (warned) return;
  warned = true;
  const parts: string[] = [];
  const ai = resolveAnthropicEnv(env);
  if (!ai.configured) parts.push(`AI features not configured: ${ai.missing.join(", ")} missing or invalid`);
  const jobs = resolveInngestEnv(env);
  if (!jobs.configured) parts.push(`Background jobs not configured: ${jobs.missing.join(", ")} missing or invalid`);
  if (env.APP_ENV?.trim() === "preview" && !env.SUPABASE_SECRET_KEY?.trim()) parts.push("No database in this preview deployment");
  if (parts.length > 0) log(`[env] ${parts.join(". ")}.`);
}
