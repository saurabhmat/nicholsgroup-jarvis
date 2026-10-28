// Build/start-time validation, used by apps/web/app/env-check.ts (build) and apps/web/instrumentation.ts (start).
// No `server-only`: it runs in plain server code and must stay importable from tests.
//
// Choice: validate only on real deployment builds, so `pnpm typecheck/lint/test` and CI (no secrets) never need
// env. A build counts as "real" per shouldValidateBuildEnv below. There is deliberately no skip flag.
import {
  EnvValidationError,
  parseServerEnv,
  type EnvRecord,
} from "./schema";
import { FREE_TEXT_VALUE_NAMES, isSecretLikeName, isSecretLikeValue } from "./secret-patterns";

/** Gate flags accept 1/true (any case); any other non-empty value is a configuration error. */
export function parseGateFlag(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (/^(1|true)$/i.test(value)) return true;
  throw new EnvValidationError("gate flags", [], [name]);
}

/**
 * True on Vercel (VERCEL=1), when forced (NICHOLS_VALIDATE_ENV), or when APP_ENV says preview/staging/production, so a
 * self-hosted deployment, or one with Vercel's "Automatically expose System Environment Variables" turned off,
 * is still validated at build and boot.
 */
export function shouldValidateBuildEnv(env: EnvRecord): boolean {
  return (
    parseGateFlag("VERCEL", env.VERCEL) ||
    parseGateFlag("NICHOLS_VALIDATE_ENV", env.NICHOLS_VALIDATE_ENV) ||
    env.APP_ENV === "preview" ||
    env.APP_ENV === "staging" ||
    env.APP_ENV === "production"
  );
}

/** Every NEXT_PUBLIC_* variable present (declared in the schema or not) must be safe for a browser. */
export function assertNoSecretPublicVars(env: EnvRecord): void {
  const bad = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("NEXT_PUBLIC_")) continue;
    const valueLooksSecret =
      typeof value === "string" && !FREE_TEXT_VALUE_NAMES.includes(key) && isSecretLikeValue(value);
    if (isSecretLikeName(key) || valueLooksSecret) bad.add(key);
  }
  if (bad.size > 0) throw new EnvValidationError("public variables (NEXT_PUBLIC_*)", [], [...bad].sort());
}

/**
 * Throws EnvValidationError (names only) on a real build/start when public variables look secret or core
 * variables are missing (plus Anthropic and Inngest in production). A no-op on CI and local builds.
 */
export function assertBuildEnv(env: EnvRecord): void {
  if (!shouldValidateBuildEnv(env)) return;
  assertNoSecretPublicVars(env);
  parseServerEnv(env);
}
