// POST /api/lanes/<lane>/sync-now (T-238): run every usable Google connection of the lane now. Owner or admin_technical at AAL2;
// one per lane per 2 minutes; audited. Logic and checks: lib/sync-now.ts.
import { connSyncRequested, sendLaneEvent } from "@nichols/core/inngest";
import { getAudit } from "@nichols/core/lane-router";
import { listMailConnectionIds } from "@nichols/connectors/sync";
import type { LaneId } from "@nichols/core";
import { guards } from "@/lib/guards";
import { createSyncNowHandler } from "@/lib/sync-now";

const handler = createSyncNowHandler({
  guards,
  audit: () => getAudit(),
  listConnections: (laneId) => listMailConnectionIds(laneId as LaneId),
  send: (laneId, connectionId, eventId) => sendLaneEvent(connSyncRequested.create({ laneId, connectionId, trigger: "manual" }, { id: eventId })),
});

export async function POST(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/sync-now">) {
  return handler(request, (await ctx.params).laneId);
}
