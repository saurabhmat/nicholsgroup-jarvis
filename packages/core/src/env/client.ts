// Browser-safe environment. Imports nothing server-only.
// Next.js inlines NEXT_PUBLIC_* only for LITERAL `process.env.NEXT_PUBLIC_X` reads, so every variable is read
// explicitly below (a test checks this list against the schema). Never loop over process.env here.
import { parseClientEnv, type ClientEnv } from "./schema";

export type { ClientEnv } from "./schema";
export { requireSupabasePublicEnv } from "./schema";

export function readClientEnvFromProcess(): Record<string, string | undefined> {
  return {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  };
}

let cached: ClientEnv | undefined;

/** Lazy and memoised: importing this module never throws, so builds without env still typecheck and lint. */
export function getClientEnv(): ClientEnv {
  cached ??= parseClientEnv(readClientEnvFromProcess());
  return cached;
}
