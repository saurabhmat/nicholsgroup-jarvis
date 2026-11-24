// GET /api/lanes/<lane>/messages/image (T-285, T-291): one inline picture of a Teams message, streamed by the server. Logic and checks: lib/teams-api.ts. GET only: HEAD answers a fixed 405 with `Allow: GET` (no Graph fetch), every other method is Next's own 405.
import { guards } from "@/lib/guards";
import { createTeamsRoutes } from "@/lib/teams-api";

const routes = createTeamsRoutes({ guards });

export async function GET(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/messages/image">) {
  return routes.image(request, (await ctx.params).laneId);
}

/** HEAD would otherwise run the GET handler (and the Graph fetch) with the body dropped: a fixed 405 instead. */
export function HEAD() {
  return new Response(null, { status: 405, headers: { allow: "GET", "cache-control": "no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" } });
}
