// Settings (T-023 placeholder) plus the temporary QuickBooks connection test (T-198). The lane gate runs first, as on
// every page; the test section is shown only to owner or admin_technical at AAL2 when the lane switched it on, and the
// check route enforces the same on its own (this only decides what is drawn).
import { loadLane } from "@/lib/lane-page";
import { guards } from "@/lib/guards";
import { connectionTestVisible } from "@/lib/connection-test";
import { ConnectionTestSection } from "./connection-test-section";
import { ModulePage } from "./module-page";

export async function SettingsPage({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const showTest = await connectionTestVisible(await guards(), lane.laneId);
  return (
    <div className="flex flex-col gap-6">
      <ModulePage module="settings" params={params} />
      {showTest ? <ConnectionTestSection laneId={lane.laneId} /> : null}
    </div>
  );
}
