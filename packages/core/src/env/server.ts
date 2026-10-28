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
export { EnvValidationError, requireSupabasePublicEnv } from "./schema";

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
 * Anthropic settings, or `{ configured: false, missing }` outside production when not (fully) set.
 * Production is always decided from the real process env; `env` only supplies values (injectable for tests).
 */
export function getAnthropicEnv(env: EnvRecord = process.env) {
  const result = resolveAnthropicEnv(env, isProduction(process.env));
  return result.configured ? withRedaction(result) : result;
}

/**
 * Inngest settings, or `{ configured: false, missing }` outside production when not (fully) set. Production is decided from the real process env.
 */
export function getInngestEnv(env: EnvRecord = process.env) {
  const result = resolveInngestEnv(env, isProduction(process.env));
  return result.configured ? withRedaction(result) : result;
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
