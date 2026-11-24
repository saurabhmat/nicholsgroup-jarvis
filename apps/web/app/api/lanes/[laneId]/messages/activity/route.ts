// GET /api/lanes/<lane>/messages/activity (T-290): the notice state of the person's OWN Teams connection, read from the portal's database only (never Microsoft): `{ live, liveUntil, dot,
// lastNoticeAt }`. POST: the person opened the chat list (`teams_activity_seen`). Rate limited per person; `no-store`. Logic and checks: lib/teams-api.ts.
import { guards } from "@/lib/guards";
import { createTeamsRoutes } from "@/lib/teams-api";

const routes = createTeamsRoutes({ guards });

export async function GET(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/messages/activity">) {
  return routes.activity(request, (await ctx.params).laneId);
}

export async function POST(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/messages/activity">) {
  return routes.seen(request, (await ctx.params).laneId);
}
