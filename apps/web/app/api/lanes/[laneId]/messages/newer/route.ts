// GET /api/lanes/<lane>/messages/newer (T-290): what changed in the open chat since a message time (a `lastModifiedDateTime` date range), after a notice or a Refresh. Logic and checks: lib/teams-api.ts.
import { guards } from "@/lib/guards";
import { createTeamsRoutes } from "@/lib/teams-api";

const routes = createTeamsRoutes({ guards });

export async function GET(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/messages/newer">) {
  return routes.newer(request, (await ctx.params).laneId);
}
