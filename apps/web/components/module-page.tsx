// Placeholder for a module page (T-023): the lane check, the page heading and the T-022 empty state. No data and no
// "Sample data" label; the real module replaces the empty state in its own task.
import { EmptyState, LaneChip, navItem, type NavKey } from "@nichols/ui";
import { loadLane } from "@/lib/lane-page";

export async function ModulePage({ module, params }: { module: NavKey; params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const item = navItem(module);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-2xl font-semibold text-foreground">{item.label}</h1>
        <LaneChip code={lane.laneId} name={lane.name} />
      </div>
      <EmptyState title={item.placeholder.title} description={item.placeholder.description} />
    </div>
  );
}
