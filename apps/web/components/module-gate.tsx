// Wraps a module's page (T-265): a company that hides the module (lib/lane-modules.ts) sends the visitor to its Home before the page
// loads anything. Not a permission: the page and the database still run their own gates.
// T-276: the gate waits for the lane row and then lane_config, and the page below it renders only after that. The page's own lane check (`loadLane`: the
// lane check plus the company list) does not depend on the gate's answer, so it is STARTED here, beside the gate, and the page finds it already
// under way (React cache(): one call per request and lane). Nothing is decided early: the gate still answers first (a hidden module redirects before
// the page below renders anything), and the page still awaits its own `loadLane`, so a refused lane is still a 404 and an AAL or session error is
// still a redirect there. The early promise has a no-op catch only so that it can never surface as an unhandled rejection while the gate redirects.
import type { ReactNode } from "react";
import type { LaneModule } from "@nichols/core/lane-config";
import { requireModule } from "@/lib/lane-modules";
import { loadLane } from "@/lib/lane-page";

export async function ModuleGate({ module, params, children }: { module: LaneModule; params: Promise<{ laneId: string }>; children: ReactNode }) {
  const laneId = (await params).laneId;
  loadLane(laneId).catch(() => undefined);
  await requireModule(laneId, module);
  return children;
}
