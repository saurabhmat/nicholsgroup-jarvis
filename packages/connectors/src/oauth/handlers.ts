// HTTP handlers for the /api/connect routes (T-035), built over a flow and a session guard so they can be tested
// without Next.js. apps/web's route files only call these.
//
// start:    POST same-origin only (it creates server state) → 303 to the provider's consent page.
// callback: GET from the provider → 303 to a fixed path with a coarse result code; provider text never reaches the page.
import { authErrorResponse } from "@nichols/core/auth";
import { isConnectorError } from "../contract/errors";
import type { AuthorizeFn, createOAuthFlow } from "./flow";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (error: string, status: number) => Response.json({ error }, { status, headers: NO_STORE });

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
