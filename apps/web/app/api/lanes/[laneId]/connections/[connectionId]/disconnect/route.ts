// POST /api/lanes/<lane>/connections/<id>/disconnect (T-257, D-55): local Disconnect of the signed-in user's own Microsoft mailbox. Logic: lib/microsoft-disconnect.ts.
import { disconnectMicrosoft } from "@nichols/connectors/microsoft-settings";
import type { LaneId } from "@nichols/core";
import { guards } from "@/lib/guards";
import { createMicrosoftDisconnectHandler } from "@/lib/microsoft-disconnect";

const handler = createMicrosoftDisconnectHandler({ guards, disconnect: (laneId, connectionId, actor) => disconnectMicrosoft(laneId as LaneId, connectionId, actor) });

export async function POST(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/connections/[connectionId]/disconnect">) {
  const { laneId, connectionId } = await ctx.params;
  return handler(request, laneId, connectionId);
}
