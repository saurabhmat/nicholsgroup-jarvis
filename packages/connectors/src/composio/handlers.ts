// HTTP handlers for the Composio routes (T-219), built over the flow and a session guard so they can be tested without
// Next.js; apps/web's route files only call these.
//   start:    POST same-origin only → 303 to the Composio-hosted consent page (or 409 `not_configured`).
//   callback: GET from Composio's redirect → 303 to the lane's Settings with a coarse result code.
//   test:     POST same-origin only → JSON `{ status, checked_at }`.
import { authErrorResponse } from "@nichols/core/auth";
import { isConnectorError } from "../contract/errors";
import type { AuthorizeFn } from "../oauth/flow";
import type { ComposioCheck } from "./check";
import type { createComposioConnect } from "./connect";
import { isToolkit, type Toolkit } from "./constants";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status: number) => Response.json(body, { status, headers: NO_STORE });

export type ComposioHandlerDeps = {
  flow: Pick<ReturnType<typeof createComposioConnect>, "start" | "callback">;
  authorizer: () => Promise<AuthorizeFn>;
  check: (laneId: string, toolkit: Toolkit) => Promise<ComposioCheck>;
};

export function createComposioHandlers(deps: ComposioHandlerDeps) {
  return {
    async start(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.headers.get("origin") !== url.origin) return json({ error: "forbidden" }, 403);
      const toolkit = url.searchParams.get("toolkit") ?? "";
      if (!isToolkit(toolkit)) return json({ error: "not_found" }, 404);
      try {
        const location = await deps.flow.start(toolkit, url.searchParams.get("lane") ?? "", await deps.authorizer());
        return new Response(null, { status: 303, headers: { ...NO_STORE, location } });
      } catch (e) {
        const res = authErrorResponse(e);
        if (res) return res;
        const kind = isConnectorError(e) ? e.info.kind : undefined;
        if (kind === "connection_unavailable") return json({ error: "not_configured" }, 409);
        if (kind === "forbidden") return json({ error: "forbidden" }, 403);
        if (kind === "rate_limited") return json({ error: "too_many_connects" }, 429);
        console.error("[api/connect/composio/start] unavailable:", e instanceof Error ? e.name : typeof e);
        return json({ error: "unavailable" }, 503);
      }
    },

    async callback(request: Request): Promise<Response> {
      const url = new URL(request.url);
      try {
        const result = await deps.flow.callback(url.searchParams, await deps.authorizer());
        const home = new URL(result.laneId ? `/${encodeURIComponent(result.laneId)}/settings` : "/", url.origin);
        home.searchParams.set("connect", result.ok ? "ok" : result.reason);
        home.searchParams.set("provider", "composio");
        if (result.toolkit) home.searchParams.set("toolkit", result.toolkit);
        if (!result.ok && result.message) home.searchParams.set("notice", "remove_app_access");
        return new Response(null, { status: 303, headers: { ...NO_STORE, location: home.pathname + home.search, "referrer-policy": "no-referrer" } });
      } catch (e) {
        const res = authErrorResponse(e);
        if (res) return res;
        console.error("[api/connect/composio/callback] unavailable:", e instanceof Error ? e.name : typeof e);
        return json({ error: "unavailable" }, 503);
      }
    },

    async test(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.headers.get("origin") !== url.origin) return json({ error: "forbidden" }, 403);
      const toolkit = url.searchParams.get("toolkit") ?? "";
      if (!isToolkit(toolkit)) return json({ error: "not_found" }, 404);
      const laneId = url.searchParams.get("lane") ?? "";
      try {
        await (await deps.authorizer())(laneId); // owner/admin_technical of the lane at aal2, or AuthError
        const { status, checked_at } = await deps.check(laneId, toolkit);
        return json({ status, checked_at }, 200);
      } catch (e) {
        const res = authErrorResponse(e);
        if (res) return res;
        console.error("[api/connect/composio/test] unavailable:", e instanceof Error ? e.name : typeof e);
        return json({ error: "unavailable" }, 503);
      }
    },
  };
}
