import "server-only";
// Platform Inngest functions (T-037). Module jobs (conn.sync T-038, finance jobs, approvals) add theirs to
// platformFunctions() or to their own lists served by app/api/inngest.
import type { Inngest, InngestFunction } from "inngest";
import { systemHeartbeat } from "./events";

/** Echoes the lane id: proves events reach functions and functions run (local dev server, deployment checks). */
function heartbeat(inngest: Inngest) {
  return inngest.createFunction({ id: "system-heartbeat", triggers: [systemHeartbeat] }, async ({ event }) => ({
    laneId: event.data.laneId,
    ok: true,
  }));
}

export function platformFunctions(inngest: Inngest): InngestFunction.Any[] {
  return [heartbeat(inngest)];
}
