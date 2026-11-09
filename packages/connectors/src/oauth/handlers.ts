// HTTP handlers for the /api/connect routes (T-035), built over a flow and a session guard so they can be tested
// without Next.js. apps/web's route files only call these.
//
// start:    POST same-origin only (it creates server state) → 303 to the provider's consent page.
// callback: GET from the provider → 303 to a fixed path with a coarse result code; provider text never reaches the page.
import { authErrorResponse } from "@nichols/core/auth";
import { EnvValidationError, describeEnvError } from "@nichols/core/env/server";
import { isConnectorError } from "../contract/errors";
import type { AuthorizeFn, createOAuthFlow } from "./flow";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (error: string, status: number) => Response.json({ error }, { status, headers: NO_STORE });

/** The lane codes the lane router issues (also the pattern of the lane in a state, pkce.ts). */
const LANE_CODE = /^[A-Z]{1,8}$/;

/**
 * Codes for the fixed banners Settings draws after a connect could not start because the server is not configured.
 * The page maps the code to text written there; nothing from the request or the error ever reaches the page.
 */
const ENV_ERROR_CODES: Readonly<Record<string, string>> = { google: "google_env" };
const GENERIC_ENV_ERROR_CODE = "connect_env";

/** A connect button is a plain form POST (the browser navigates); a script or API client is not. */
function isFormNavigation(request: Request): boolean {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  return type.startsWith("application/x-www-form-urlencoded") || type.startsWith("multipart/form-data") || request.headers.get("sec-fetch-mode") === "navigate";
}

export function createConnectHandlers(flow: Pick<ReturnType<typeof createOAuthFlow>, "has" | "start" | "callback">, authorizer: () => Promise<AuthorizeFn>) {
  return {
    async start(request: Request, provider: string): Promise<Response> {
      if (!flow.has(provider)) return json("not_found", 404);
      const url = new URL(request.url);
      if (request.headers.get("origin") !== url.origin) return json("forbidden", 403);
      try {
        const location = await flow.start(provider, url.searchParams.get("lane") ?? "", await authorizer());
        return new Response(null, { status: 303, headers: { ...NO_STORE, location } });
      } catch (e) {
        const res = authErrorResponse(e);
        if (res) return res;
        if (e instanceof EnvValidationError) {
          // Variable NAMES and the rule each broke, never values (the error carries none).
          console.error(`[api/connect/start] not configured (${provider}): ${describeEnvError(e)}`);
          const lane = url.searchParams.get("lane") ?? "";
          if (isFormNavigation(request) && LANE_CODE.test(lane)) {
            const code = ENV_ERROR_CODES[provider] ?? GENERIC_ENV_ERROR_CODE;
            return new Response(null, { status: 303, headers: { ...NO_STORE, location: `/${lane}/settings?error=${code}` } });
          }
          return json("unavailable", 503);
        }
        const kind = isConnectorError(e) ? e.info.kind : undefined;
        if (kind === "forbidden") return json("forbidden", 403);
        if (kind === "rate_limited") return json("too_many_connects", 429);
        console.error("[api/connect/start] unavailable:", e instanceof Error ? e.name : typeof e);
        return json("unavailable", 503);
      }
    },

    async callback(request: Request, provider: string): Promise<Response> {
      if (!flow.has(provider)) return json("not_found", 404);
      const url = new URL(request.url);
      try {
        const result = await flow.callback(provider, url.searchParams, await authorizer());
        // Back to the lane's Settings page, which shows the result. The lane is parsed from `state` (`[A-Z]{1,8}`, pkce.ts)
        // and passed `authorize` for this user; it is not necessarily a matched state row, so use it for this redirect only.
        // Without a lane (garbage state, unknown provider) back to the entry page, which drops the result (accepted).
        const home = new URL(result.laneId ? `/${encodeURIComponent(result.laneId)}/settings` : "/", url.origin);
        home.searchParams.set("connect", result.ok ? "ok" : result.reason);
        if (result.provider) home.searchParams.set("provider", result.provider);
        // The code was exchanged but nothing was stored: the owner is told to remove the app's access at the provider (D-24).
        if (!result.ok && result.message) home.searchParams.set("notice", "remove_app_access");
        return new Response(null, { status: 303, headers: { ...NO_STORE, location: home.pathname + home.search, "referrer-policy": "no-referrer" } });
      } catch (e) {
        const res = authErrorResponse(e);
        if (res) return res;
        console.error("[api/connect/callback] unavailable:", e instanceof Error ? e.name : typeof e);
        return json("unavailable", 503);
      }
    },
  };
}
