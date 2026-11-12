// Home header status dot (T-234 part 1): shown only when a mail or calendar source is stale or in error; links to
// Settings -> Connections where Coverage lists each source. The dot is not the only signal: it has an accessible name and
// the visible word "Sync issue" beside it (WCAG: not colour alone). Nothing is drawn when all is well; when Coverage cannot be read it says "Status unknown" (never a silent all-clear).
import Link from "next/link";
import { laneHref } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { coverageFor, needsAttention, type CoverageView } from "@/lib/coverage";
import { timed } from "@/lib/timed";

const DOT_LINK = "inline-flex min-h-11 items-center gap-2 rounded-control px-2 text-small font-medium text-foreground underline-offset-2 hover:underline sm:min-h-0";

export async function HomeCoverageDot({ laneId }: { laneId: string }) {
  const view = await timed("load.home_coverage", async () => coverageFor(await guards(), laneId, new Date()));
  return <CoverageDot laneId={laneId} view={view} />;
}

export function CoverageDot({ laneId, view }: { laneId: string; view: CoverageView }) {
  if (view.unavailable) {
    const unknown = "Sync status could not be checked. Open Settings, Connections.";
    return (
      <Link href={`${laneHref(laneId, "settings")}#connections`} data-testid="coverage-dot" data-status="unknown" aria-label={unknown} title={unknown} className={DOT_LINK}>
        <span aria-hidden className="size-2.5 rounded-full border-2 border-muted-foreground" />
        Status unknown
      </Link>
    );
  }
  if (!needsAttention(view.items)) return null;
  const n = view.items.filter((c) => c.state === "stale" || c.state === "error").length;
  const label = `${String(n)} ${n === 1 ? "source is" : "sources are"} stale or in error. Open Settings, Connections.`;
  return (
    <Link href={`${laneHref(laneId, "settings")}#connections`} data-testid="coverage-dot" aria-label={label} title={label} className={DOT_LINK}>
      <span aria-hidden className="size-2.5 rounded-full bg-alert" />
      Sync issue
    </Link>
  );
}
