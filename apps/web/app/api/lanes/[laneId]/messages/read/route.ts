// POST /api/lanes/<lane>/messages/read (T-283): opening a chat records the portal's own read marker (an id and a time; nothing is written at Microsoft). Logic and checks: lib/teams-api.ts.
import { guards } from "@/lib/guards";
import { createTeamsRoutes } from "@/lib/teams-api";

const routes = createTeamsRoutes({ guards });

export async function POST(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/messages/read">) {
  return routes.read(request, (await ctx.params).laneId);
}
