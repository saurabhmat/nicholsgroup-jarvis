// Placeholder for a module page without a prototype screen yet (T-023, T-024): the lane check, the shared page header
// and one T-022 empty state. No data and no "Sample data" label; the real module replaces the empty state in its own task.
import { EmptyState, navItem, PageHeader, type NavKey } from "@nichols/ui";
import { loadLane } from "@/lib/lane-page";

export async function ModulePage({ module, params }: { module: NavKey; params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const item = navItem(module);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={lane.name} title={item.heading.lead} accent={item.heading.accent} />
      <EmptyState title={item.placeholder.title} description={item.placeholder.description} />
    </div>
  );
}
