// Home KPI row (T-234 part 1, T-237 part B): an auto-fit grid of tiles (two per row on a phone). Every tile has the same three
// rows (label, figure, note), a minimum height and `h-full`. Cash always carries the "Book balance" label (rule 7). No figure is
// ever invented. T-240: QuickBooks not connected (or needing a reconnect) is a slim one-line strip above the row, not a full-size tile.
import Link from "next/link";
import { BookBalanceLabel, laneHref } from "@nichols/ui";
import type { KpiTile, QuickbooksStrip } from "@/lib/home-kpi-tiles";

export const TILE_HEIGHT = "min-h-[8rem]";
// Several tiles share the row (auto-fit); a lone tile (MRR only) keeps one tile's width (auto-fill keeps the empty tracks).
const FIT_COLUMNS = "md:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]";
const LONE_COLUMNS = "md:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]";
const TONE = { danger: "text-danger", success: "text-success" } as const;

/** No tiles and no strip: nothing (a role that cannot connect and has no finance view must not be told about finance figures). */
export function KpiStrip({ laneId, tiles, strip = null }: { laneId: string; tiles: KpiTile[]; strip?: QuickbooksStrip | null }) {
  if (tiles.length === 0 && !strip) return null;
  const row =
    tiles.length === 0 ? null : (
      <section aria-labelledby="kpi-heading" data-testid="home-kpis" className={`grid grid-cols-2 items-stretch gap-3 md:gap-5 ${tiles.length === 1 ? LONE_COLUMNS : FIT_COLUMNS}`}>
        <h2 id="kpi-heading" className="sr-only">Key figures</h2>
        {tiles.map((t) => (
          <Tile key={t.key} tile={t} />
        ))}
      </section>
    );
  if (!strip) return row;
  return (
    <div className="flex flex-col gap-3">
      <QuickbooksStripLine laneId={laneId} strip={strip} />
      {row}
    </div>
  );
}

/**
 * One line, not a tile: the text, and (owner / admin_technical only) a link to Settings -> Connections. A status region so a screen reader
 * hears it; the link says what it does ("Connect QuickBooks in Settings") and has a 44 px target on a phone. Colours are tokens.
 */
function QuickbooksStripLine({ laneId, strip }: { laneId: string; strip: QuickbooksStrip }) {
  return (
    <div role="status" data-testid="qb-strip" data-kind={strip.kind} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-control border border-border bg-card px-4 py-2 text-small text-muted-foreground">
      <p className="min-w-0 flex-1">{strip.text}</p>
      {strip.canConnect ? (
        <Link
          href={`${laneHref(laneId, "settings")}#connections`}
          data-testid="kpi-connect"
          aria-label={`${strip.actionLabel} QuickBooks in Settings`}
          className="inline-flex shrink-0 items-center font-sans text-small font-semibold text-primary underline-offset-2 hover:underline max-md:min-h-11"
        >
          {strip.actionLabel} <span aria-hidden>{"\u2192"}</span>
        </Link>
      ) : null}
    </div>
  );
}

function Tile({ tile }: { tile: KpiTile }) {
  const has = tile.value !== undefined && tile.value !== "";
  return (
    <div data-slot="kpi-tile" data-testid="kpi-tile" data-kpi={tile.key} data-status={has ? "ok" : "no_data"} className={`flex h-full min-w-0 flex-col justify-between gap-2 rounded-card border border-border bg-card p-5 text-card-foreground shadow-card ${TILE_HEIGHT}`}>
      <div className="flex min-h-10 flex-col gap-1">
        <p data-slot="kpi-label" className="font-sans text-label font-medium uppercase tracking-wide text-muted-foreground">{tile.label}</p>
        {tile.bookBalance ? <BookBalanceLabel /> : null}
        {tile.qualifier ? <p className="text-small text-muted-foreground">{tile.qualifier}</p> : null}
      </div>
      {has ? (
        <p data-slot="kpi-value" data-tone={tile.tone ?? "none"} className={`min-w-0 break-words font-sans text-card-title font-semibold tabular-nums ${tile.tone ? TONE[tile.tone] : "text-foreground"}`}>
          {tile.value}
        </p>
      ) : (
        <p data-slot="kpi-value" className="font-sans text-card-title font-semibold text-muted-foreground">
          {/* aria-label is not allowed on a plain paragraph (axe aria-prohibited-attr): the dash is hidden, the words are read. */}
          <span aria-hidden>{"—"}</span>
          <span className="sr-only">No figure</span>
        </p>
      )}
      <div data-slot="kpi-note" className="flex min-h-8 flex-col gap-1 text-small text-muted-foreground">
        {tile.flags.map((f) => (
          <p key={f} data-slot="kpi-flag" className="font-medium text-foreground">
            {f}
          </p>
        ))}
        {tile.note ? <p>{tile.note}</p> : null}
      </div>
    </div>
  );
}
