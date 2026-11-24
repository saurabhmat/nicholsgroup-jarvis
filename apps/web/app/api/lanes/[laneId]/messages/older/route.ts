// GET /api/lanes/<lane>/messages/older (T-283): one more page of a chat's older messages, by the person's click. Logic and checks: lib/teams-api.ts.
import { guards } from "@/lib/guards";
import { createTeamsRoutes } from "@/lib/teams-api";

const routes = createTeamsRoutes({ guards });

export async function GET(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/messages/older">) {
  return routes.older(request, (await ctx.params).laneId);
}
