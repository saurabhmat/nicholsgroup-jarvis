// Home header sync status (T-234 part 1, T-237 part C, T-238 part D): "Mail synced 4 min ago · Calendar synced 12 min ago", from the same
// coverage rows as Settings -> Connections. Ages use the OLDEST last-good sync among a stream's sources (never optimistic); the title and
// the accessible name carry the Eastern clock times ("Mail last synced 9:42 AM ET"). When a stream's latest sync failed, its real error
// is shown as the FIXED text for the error code (never provider text), with how many mailboxes failed when there are several; the link
// goes to Settings -> Connections. Not colour alone: the dot sits beside the words. Phone: one compact word ("Synced" / "Sync issue"), the
// full text stays for screen readers, so the header never scrolls sideways. "Status unknown" when Coverage cannot be read; nothing is
// drawn when no source is connected. Owners and admin_technical also get "Sync now" beside it.
import Link from "next/link";
import { laneHref } from "@nichols/ui";
import { syncStatus, type StreamSync } from "@nichols/briefing/domain";
import { CONNECT_ROLES } from "@nichols/connectors/oauth";
import { guards } from "@/lib/guards";
import { coverageFor, type CoverageView } from "@/lib/coverage";
import { timed } from "@/lib/timed";
import { SyncNowButton } from "./sync-now-button";

const DOT_LINK = "inline-flex min-h-11 items-center gap-2 rounded-control px-2 text-small font-medium text-foreground underline-offset-2 hover:underline sm:min-h-0";

export async function HomeCoverageDot({ laneId, now = new Date() }: { laneId: string; now?: Date }) {
  const g = await guards();
  const [view, canSync] = await Promise.all([
    timed("load.home_coverage", async () => coverageFor(g, laneId, now)),
    g.requireRole(laneId as Parameters<typeof g.requireRole>[0], CONNECT_ROLES).then(() => true, () => false),
  ]);
  return <CoverageDot laneId={laneId} view={view} now={now} canSync={canSync} />;
}

/** The header text: the streams' sentences joined with " · ". */
export const syncLine = (streams: StreamSync[]): string => streams.map((s) => s.text).join(" · ");

export function CoverageDot({ laneId, view, now = new Date(), canSync = false }: { laneId: string; view: CoverageView; now?: Date; canSync?: boolean }) {
  const href = `${laneHref(laneId, "settings")}#connections`;
  let link: React.ReactNode;
  if (view.unavailable) {
    const unknown = "Sync status could not be checked. Open Settings, Connections.";
    link = (
      <Link href={href} data-testid="coverage-dot" data-status="unknown" aria-label={unknown} title={unknown} className={DOT_LINK}>
        <span aria-hidden className="size-2.5 rounded-full border-2 border-muted-foreground" />
        Status unknown
      </Link>
    );
  } else {
    const streams = syncStatus(view.items, now);
    if (streams.length === 0) return null; // no source connected: nothing to report
    const failed = streams.some((s) => s.state === "failed");
    const attention = failed || streams.some((s) => s.state !== "ok");
    const detail = [...streams.map((s) => s.detail), "Open Settings, Connections."].join(" ");
    link = (
      <Link href={href} data-testid="coverage-dot" data-status={failed ? "failed" : attention ? "attention" : "synced"} aria-label={detail} title={detail} className={`${DOT_LINK} md:max-w-[34rem] md:items-start md:py-1`}>
        <span aria-hidden className={`size-2.5 shrink-0 rounded-full max-md:self-center md:mt-1 ${attention ? "bg-alert" : "bg-success"}`} />
        <span data-slot="sync-full" className="max-md:sr-only md:[overflow-wrap:anywhere]">{syncLine(streams)}</span>
        <span aria-hidden className="md:hidden">{attention ? "Sync issue" : "Synced"}</span>
      </Link>
    );
  }
  if (!canSync) return link;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="sync-status">
      {link}
      <SyncNowButton laneId={laneId} testId="home-sync-now" />
    </span>
  );
}
