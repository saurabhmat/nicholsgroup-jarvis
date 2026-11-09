// T-230 A: the neutral placeholder every [laneId] page shows while its data loads (loading.tsx and Suspense fallbacks).
// Deliberately plain (muted blocks with the design tokens' colours and radii, no copy and no data): Part B restyles the
// pages and the placeholder follows. The shell and menu stay; only the content area is replaced.
import { cn } from "@nichols/ui";

function Block({ className }: { className?: string }) {
  return <div aria-hidden className={cn("rounded-control bg-muted motion-safe:animate-pulse", className)} />;
}

export function PageSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite" data-testid="page-skeleton" className="flex flex-col gap-6">
      <span className="sr-only">Loading</span>
      <div className="flex flex-col gap-2">
        <Block className="h-4 w-40" />
        <Block className="h-8 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Block key={i} className="h-24 rounded-card" />
        ))}
      </div>
      <Block className="h-40 rounded-card" />
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
