// POST /api/lanes/<lane>/connections/<id>/disconnect-teams (T-280): local Disconnect of the signed-in user's own Teams account. Same rules and handler as the Microsoft mailbox Disconnect
// (lib/microsoft-disconnect.ts: owner only, AAL2, same-origin, fixed answers); the connector refuses any row that is not the caller's own Teams connection (`not_found`).
import { disconnectTeams } from "@nichols/connectors/teams-settings";
import type { LaneId } from "@nichols/core";
import { guards } from "@/lib/guards";
import { createMicrosoftDisconnectHandler } from "@/lib/microsoft-disconnect";

const handler = createMicrosoftDisconnectHandler({ guards, disconnect: (laneId, connectionId, actor) => disconnectTeams(laneId as LaneId, connectionId, actor) });

export async function POST(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/connections/[connectionId]/disconnect-teams">) {
  const { laneId, connectionId } = await ctx.params;
  return handler(request, laneId, connectionId);
}
