import "server-only";
// Server-only environment. Importing this from a client component fails the Next.js build (`server-only`).
// Import path: @nichols/core/env/server
import { withRedaction } from "./redact";
import {
  CLIENT_ENV_NAMES,
  EnvValidationError,
  isProduction,
  parseConnectorEnv,
  parseServerEnv,
  runtimeFlags,
  resolveAnthropicEnv,
  resolveInngestEnv,
  type ConnectorEnv,
  type ConnectorName,
  type EnvRecord,
  type ServerEnv,
} from "./schema";

export type { ConnectorEnv, ConnectorName, GroupResult, ServerEnv } from "./schema";
export { EnvValidationError, describeEnvError, requireSupabasePublicEnv } from "./schema";

type Loaded = { env: ServerEnv; supabaseSecretKey: string | undefined };
let cached: Loaded | undefined;

function load(): Loaded {
  if (cached) return cached;
  const all = parseServerEnv(process.env);
  const env: ServerEnv = withRedaction({
    ...Object.fromEntries(CLIENT_ENV_NAMES.map((name) => [name, all[name]])),
    APP_ENV: all.APP_ENV,
    ENABLED_LANES: all.ENABLED_LANES,
    SUPABASE_NL_URL: all.SUPABASE_NL_URL,
  } as ServerEnv);
  cached = { env, supabaseSecretKey: all.SUPABASE_SECRET_KEY };
  return cached;
}

/**
 * Core configuration (app, lanes, Supabase URLs). Contains NO secrets. Throws EnvValidationError on first use
 * if a core variable is missing or invalid. Memoised.
 */
export function getServerEnv(): ServerEnv {
  return load().env;
}

/**
 * The Supabase secret key. Narrow accessor: only the lane router and the token vault may call it (T-003 lint).
 * Throws on a PR Preview without a database (APP_ENV=preview); every other environment requires the key.
 */
export function getSupabaseSecretKey(): string {
  const key = load().supabaseSecretKey;
  if (key === undefined) throw new EnvValidationError("Supabase (no database in this deployment)", ["SUPABASE_SECRET_KEY"], []);
  return key;
}

/**
 * Anthropic settings, or `{ configured: false, missing }` when not set (outside production also when partly set).
 * Production is always decided from the real process env; `env` only supplies values (injectable for tests).
 */
/**
 * Anthropic SDK variables that could add request headers, redirect traffic or log/trace request bodies. packages/ai
 * pins baseURL, logLevel and tracing in the client constructor, but the SDK still reads ANTHROPIC_CUSTOM_HEADERS, so
 * any of these being set switches the AI feature off (configured:false + refused) instead of being honoured (T-100 M1).
 */
export const REFUSED_ANTHROPIC_SDK_ENV = [
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_LOG",
  "ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

export function getAnthropicEnv(env: EnvRecord = process.env) {
  // The SDK reads the real process env whatever `env` is passed, so check both.
  const refused = REFUSED_ANTHROPIC_SDK_ENV.filter((k) => env[k] || process.env[k]);
  // Not configured (AI off, the page says so) rather than an exception: shells often set ANTHROPIC_BASE_URL.
  if (refused.length > 0) return { configured: false as const, missing: [] as string[], refused: [...refused] };
  const result = resolveAnthropicEnv(env, isProduction(process.env));
  return result.configured ? withRedaction(result) : result;
}

/**
 * Inngest settings, or `{ configured: false, missing }` when not set (outside production also when partly set). Production is decided from the real process env.
 */
export function getInngestEnv(env: EnvRecord = process.env) {
  const result = resolveInngestEnv(env, isProduction(process.env));
  return result.configured ? withRedaction(result) : result;
}

/**
 * T-230 A: whether request timings (names and durations only) are recorded and published: always in `next dev`, in a
 * production build only when the operator sets the SERVER_TIMING env var to exactly "1". Never decided by a request.
 */
export function serverTimingEnabled(env: EnvRecord = process.env): boolean {
  return env.NODE_ENV === "development" || env.SERVER_TIMING === "1";
}

/** True when this process runs a development build (`next dev`, tests), never a production build (`next start`). */
export function isDevelopmentRuntime(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Credentials for one connector, validated when the connector is used. Fails closed: throws an error that names
 * the missing variables and never prints values. `env` is injectable for tests.
 */
export function requireConnectorEnv<C extends ConnectorName>(
  connector: C,
  env: EnvRecord = process.env,
): ConnectorEnv<C> {
  return withRedaction(parseConnectorEnv(connector, env, runtimeFlags(process.env)));
}
