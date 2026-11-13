// Home header sync status (T-234 part 1, T-237 part C): when a mail or calendar source is stale or in error a dot and "Sync issue"; links to
// Settings -> Connections where Coverage lists each source. The dot is not the only signal: it has an accessible name and
// the visible word "Sync issue" beside it (WCAG: not colour alone). When every connected source is fine it says "All sources synced · N min ago" (the oldest last sync among them, so it is never optimistic); nothing is drawn when no source is connected; when Coverage cannot be read it says "Status unknown" (never a silent all-clear).
import Link from "next/link";
import { laneHref } from "@nichols/ui";
import { ago } from "@nichols/briefing/domain";
import { guards } from "@/lib/guards";
import { coverageFor, needsAttention, type CoverageView } from "@/lib/coverage";
import { timed } from "@/lib/timed";

const DOT_LINK = "inline-flex min-h-11 items-center gap-2 rounded-control px-2 text-small font-medium text-foreground underline-offset-2 hover:underline sm:min-h-0";

export async function HomeCoverageDot({ laneId, now = new Date() }: { laneId: string; now?: Date }) {
  const view = await timed("load.home_coverage", async () => coverageFor(await guards(), laneId, now));
  return <CoverageDot laneId={laneId} view={view} now={now} />;
}

/** "All sources synced · 2 min ago": the age of the OLDEST last sync among the sources that are fine (null when none is known). */
export function syncedLabel(items: CoverageView["items"], now: Date): string {
  const times = items.filter((c) => c.state === "ok" && c.lastSyncAt).map((c) => Date.parse(c.lastSyncAt as string)).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return "All sources synced";
  return `All sources synced \u00b7 ${ago(new Date(Math.min(...times)).toISOString(), now)}`;
}

export function CoverageDot({ laneId, view, now = new Date() }: { laneId: string; view: CoverageView; now?: Date }) {
  if (view.unavailable) {
    const unknown = "Sync status could not be checked. Open Settings, Connections.";
    return (
      <Link href={`${laneHref(laneId, "settings")}#connections`} data-testid="coverage-dot" data-status="unknown" aria-label={unknown} title={unknown} className={DOT_LINK}>
        <span aria-hidden className="size-2.5 rounded-full border-2 border-muted-foreground" />
        Status unknown
      </Link>
    );
  }
  if (!needsAttention(view.items)) {
    if (!view.items.some((c) => c.state === "ok")) return null; // no source connected: nothing to report
    const text = syncedLabel(view.items, now);
    return (
      <Link href={`${laneHref(laneId, "settings")}#connections`} data-testid="coverage-dot" data-status="synced" className={DOT_LINK}>
        <span aria-hidden className="size-2.5 rounded-full bg-success" />
        {/* Phone: one compact word; the full text stays for screen readers (and shows from md). */}
        <span data-slot="sync-full" className="max-md:sr-only">{text}</span>
        <span aria-hidden className="md:hidden">Synced</span>
      </Link>
    );
  }
  const n = view.items.filter((c) => c.state === "stale" || c.state === "error").length;
  const label = `${String(n)} ${n === 1 ? "source is" : "sources are"} stale or in error. Open Settings, Connections.`;
  return (
    <Link href={`${laneHref(laneId, "settings")}#connections`} data-testid="coverage-dot" aria-label={label} title={label} className={DOT_LINK}>
      <span aria-hidden className="size-2.5 rounded-full bg-alert" />
      Sync issue
    </Link>
  );
}
