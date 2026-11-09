// T-230 A/B: the neutral placeholder every [laneId] page shows while its data loads (loading.tsx and Suspense fallbacks).
// Deliberately plain (muted blocks with the design tokens' colours and radii, no copy and no data). Part B: it has the
// SAME grid as the new Home (briefing, four figure cards in one row, 2/3 + 1/3 below), so the skeleton-to-content swap
// does not jump. The shell and menu stay; only the content area is replaced.
import { cn } from "@nichols/ui";

function Block({ className }: { className?: string }) {
  return <div aria-hidden className={cn("rounded-control bg-muted motion-safe:animate-pulse", className)} />;
}

/** The card grid of Home as muted blocks: briefing, four figure cards, then 2/3 + 1/3. */
function Grid() {
  return (
    <>
      <Block className="h-36 rounded-card" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Block key={i} className="h-32 rounded-card" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Block className="h-72 rounded-card lg:col-span-2" />
        <Block className="h-72 rounded-card" />
      </div>
    </>
  );
}

export function PageSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite" data-testid="page-skeleton" className="flex flex-col gap-4">
      <span className="sr-only">Loading</span>
      <div className="mb-2 flex flex-col gap-2">
        <Block className="h-4 w-40" />
        <Block className="h-8 w-72 max-w-full" />
      </div>
      <Grid />
    </div>
  );
}

/** The streaming body of Home (its header is already shown): same blocks as the page skeleton. */
export function HomeSkeleton() {
  return (
    <div role="status" aria-busy="true" data-testid="card-skeleton" className="flex min-w-0 flex-col gap-4">
      <span className="sr-only">Loading</span>
      <Grid />
    </div>
  );
}

/** A card-sized placeholder for a slow section inside a page whose header is already shown. */
export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div role="status" aria-busy="true" data-testid="card-skeleton" className={cn("min-w-0", className)}>
      <span className="sr-only">Loading</span>
      <Block className="h-40 rounded-card" />
    </div>
  );
}
