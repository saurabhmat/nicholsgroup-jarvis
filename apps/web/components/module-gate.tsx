// Wraps a module's page (T-265): a company that hides the module (lib/lane-modules.ts) sends the visitor to its Home before the page
// loads anything. Not a permission: the page and the database still run their own gates.
import type { ReactNode } from "react";
import type { LaneModule } from "@nichols/core/lane-config";
import { requireModule } from "@/lib/lane-modules";

export async function ModuleGate({ module, params, children }: { module: LaneModule; params: Promise<{ laneId: string }>; children: ReactNode }) {
  await requireModule((await params).laneId, module);
  return children;
}
