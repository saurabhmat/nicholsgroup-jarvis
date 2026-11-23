// Placeholder for a module page without a prototype screen yet (T-023, T-024): the lane check, the shared page header
// and one T-022 empty state. No data and no "Sample data" label; the real module replaces the empty state in its own task.
// T-276: the heading and the card are fixed text, so they are drawn outside any Suspense (part of the prefetched shell); the only dynamic value is the
// company name in the eyebrow, which a small async child reads from `loadLane`. That child is also the lane check of the page: a refused lane is still a
// 404 and a missing session or MFA is still a redirect on every navigation (the layout is not re-rendered between its pages).
import { Suspense, type ReactNode } from "react";
import { EmptyState, navItem, PageHeader, type NavKey } from "@nichols/ui";
import { loadLane } from "@/lib/lane-page";

/** The company name for a page's eyebrow, and the page's lane check (`loadLane` throws notFound / redirect). */
export async function LaneName({ params }: { params: Promise<{ laneId: string }> }) {
  return (await loadLane((await params).laneId)).name;
}

/** The eyebrow slot: a blank line of the same height until the company name arrives, so the heading does not move. */
export function LaneEyebrow({ params }: { params: Promise<{ laneId: string }> }): ReactNode {
  return (
    <Suspense fallback={<span aria-hidden>&nbsp;</span>}>
      <LaneName params={params} />
    </Suspense>
  );
}

/** `placeholder={false}` keeps the page header and drops the "not set up yet" card (a page that has real sections of its own). Awaits the lane check first: for gated pages and Settings (T-276: the shell form below is only for the pages that have no gate). */
export async function ModulePage({ module, params, placeholder = true }: { module: NavKey; params: Promise<{ laneId: string }>; placeholder?: boolean }) {
  const lane = await loadLane((await params).laneId);
  const item = navItem(module);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={lane.name} title={item.heading.lead} accent={item.heading.accent} />
      {placeholder ? <EmptyState title={item.placeholder.title} description={item.placeholder.description} /> : null}
    </div>
  );
}

/** The "not set up yet" card of a module alone (no header, no lane read): for a page that drew its header already and finds it has nothing real to show. */
export function ModulePlaceholder({ module }: { module: NavKey }) {
  const item = navItem(module);
  return <EmptyState title={item.placeholder.title} description={item.placeholder.description} />;
}

/** T-276: the same page for a module with no gate (Contacts, Messages): not async, so the heading and the card are in the prefetched shell; only the eyebrow (and the lane check) streams. */
export function ShellModulePage({ module, params }: { module: NavKey; params: Promise<{ laneId: string }> }) {
  const item = navItem(module);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={<LaneEyebrow params={params} />} title={item.heading.lead} accent={item.heading.accent} />
      <EmptyState title={item.placeholder.title} description={item.placeholder.description} />
    </div>
  );
}
