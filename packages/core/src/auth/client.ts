import "server-only";
// The auth-only Supabase client over the request cookies (T-017/T-018/T-019). Used for `auth.*` calls only, never
// `.from()` / `.rpc()`: data access goes through the lane router.
import { createServerClient } from "@supabase/ssr";
import type { Database } from "../db/index";
import { getServerEnv, requireSupabasePublicEnv } from "../env/server";
import type { CookieStore } from "./index";

/** Session cookie attributes; exported for the test that pins them. */
export const SESSION_COOKIE_OPTIONS = (appEnv: string) =>
  ({ httpOnly: true, secure: appEnv !== "local", sameSite: "lax", path: "/" }) as const;

/** The auth-only client over the request cookies. Used for `auth.*` calls only, never `.from()` / `.rpc()`. */
export function authClient(cookies: CookieStore) {
  const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key } = requireSupabasePublicEnv(getServerEnv());
  const env = getServerEnv();
  return createServerClient<Database>(url, key, {
    // No browser client reads the session (all auth runs on the server), so the cookies are script-proof
    // (T-018 review M3): httpOnly, Secure outside local development, SameSite=Lax.
    cookieOptions: SESSION_COOKIE_OPTIONS(env.APP_ENV),
    cookies: {
      getAll: () => cookies.getAll(),
      setAll: (list, headers) => {
        // Refreshed tokens are written back where the framework allows it (proxy, route handlers, server actions); in
        // a server component setting cookies throws, and proxy.ts refreshes the session instead. `headers` carries
        // no-store cache headers for responses that set session cookies.
        try {
          cookies.setAll?.(list, headers);
        } catch {
          /* read-only cookie store */
        }
      },
    },
  });
}
