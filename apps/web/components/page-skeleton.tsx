// T-230 A/B: the neutral placeholder every [laneId] page shows while its data loads (loading.tsx and Suspense fallbacks).
// Deliberately plain (muted blocks with the design tokens' colours and radii, no copy and no data). Part B: each variant
// has the SAME grid as its page (Home: attention + calendar, the KPI strip, news + projects; Settings: 200px sub-nav + sections;
// Get started: 280px step rail + panel; list: a column of cards), so the skeleton-to-content swap does not jump.
// The shell and menu stay; only the content area is replaced.
import { cn } from "@nichols/ui";

function Block({ className, ...rest }: { className?: string; "data-testid"?: string }) {
  return <div aria-hidden {...rest} className={cn("rounded-control bg-muted motion-safe:animate-pulse", className)} />;
}

/** The KPI strip as one slim bar (its own Suspense fallback on Home). The strip is a banner or a row of tiles; a slim bar avoids a layout shift for the common "nothing connected" case. */
export function KpiStripSkeleton() {
  return <Block data-testid="kpi-skeleton" className="h-10 rounded-card" />;
}

/** The card grid of Home as muted blocks (T-234): attention 2/3 + calendar 1/3, the KPI strip, news 2/3 + projects 1/3. */
function Grid() {
  return (
    <>
      <div className="grid gap-5 lg:grid-cols-3">
        <Block className="h-72 rounded-card lg:col-span-2" />
        <Block className="h-72 rounded-card" />
      </div>
      <KpiStripSkeleton />
      <div className="grid gap-5 lg:grid-cols-3">
        <Block className="h-56 rounded-card lg:col-span-2" />
        <Block className="h-56 rounded-card" />
      </div>
    </>
  );
}

/** Settings: the 200px sub-nav (a chip row on iPhone) and the section cards. */
function SettingsGrid() {
  return (
    <div className="grid gap-4 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-6">
      <div className="flex flex-wrap gap-2 lg:flex-col">
        {[0, 1, 2].map((i) => (
          <Block key={i} className="h-11 w-32 lg:w-full" />
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Block className="h-72 rounded-card" />
        <Block className="h-40 rounded-card" />
      </div>
    </div>
  );
}

/** Get started: the 280px step rail (from xl, as in the wizard) and the panel. */
function SetupGrid() {
  return (
    <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)] xl:gap-6">
      <div className="hidden flex-col gap-2 xl:flex">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Block key={i} className="h-11" />
        ))}
      </div>
      <Block className="h-96 rounded-card" />
    </div>
  );
}

/** Inbox, Calendar, Approvals and the other list pages: a column of full-width cards. */
function ListGrid() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <Block key={i} className="h-28 rounded-card" />
      ))}
    </>
  );
}

export type SkeletonVariant = "home" | "settings" | "setup" | "list";

const GRIDS: Record<SkeletonVariant, () => React.JSX.Element> = { home: Grid, settings: SettingsGrid, setup: SetupGrid, list: ListGrid };

export function PageSkeleton({ variant = "home" }: { variant?: SkeletonVariant }) {
  const Body = GRIDS[variant];
  return (
    <div role="status" aria-busy="true" aria-live="polite" data-testid="page-skeleton" data-variant={variant} className="flex flex-col gap-4">
      <span className="sr-only">Loading</span>
      <div className="mb-2 flex flex-col gap-2">
        <Block className="h-4 w-40" />
        <Block className="h-8 w-72 max-w-full" />
      </div>
      <Body />
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
