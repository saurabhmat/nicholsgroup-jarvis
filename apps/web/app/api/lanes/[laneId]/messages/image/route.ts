// GET /api/lanes/<lane>/messages/image (T-285, T-291): one inline picture of a Teams message, streamed by the server. Logic and checks: lib/teams-api.ts. GET only (any other method is a 405).
import { guards } from "@/lib/guards";
import { createTeamsRoutes } from "@/lib/teams-api";

const routes = createTeamsRoutes({ guards });

export async function GET(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/messages/image">) {
  return routes.image(request, (await ctx.params).laneId);
}
