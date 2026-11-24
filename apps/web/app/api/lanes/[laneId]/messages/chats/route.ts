// GET /api/lanes/<lane>/messages/chats (T-290): the chat list again, after a notice arrived or the person pressed Refresh. The same read the page makes. Logic and checks: lib/teams-api.ts.
import { guards } from "@/lib/guards";
import { createTeamsRoutes } from "@/lib/teams-api";

const routes = createTeamsRoutes({ guards });

export async function GET(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/messages/chats">) {
  return routes.chats(request, (await ctx.params).laneId);
}
