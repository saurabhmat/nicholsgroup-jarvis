// POST /api/lanes/<lane>/messages/call-link (T-284): the https link that opens Teams to call (or video call) the people of a chat. Validated values only; the portal never opens it. Logic and checks: lib/teams-api.ts.
import { guards } from "@/lib/guards";
import { createTeamsRoutes } from "@/lib/teams-api";

const routes = createTeamsRoutes({ guards });

export async function POST(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/messages/call-link">) {
  return routes.callLink(request, (await ctx.params).laneId);
}
