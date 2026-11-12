// Home KPI row (T-234 part 1, T-237 part B): an auto-fit grid of tiles (two per row on a phone). Every tile has the same three
// rows (label, figure, note), a minimum height and `h-full`. Cash always carries the "Book balance" label (rule 7). No figure is
// ever invented. With QuickBooks not connected the row holds one "Connect QuickBooks" tile (only built for a role that can connect).
import Link from "next/link";
import { BookBalanceLabel, laneHref } from "@nichols/ui";
import type { KpiTile } from "@/lib/home-kpi-tiles";

export const TILE_HEIGHT = "min-h-[8rem]";
// Several tiles share the row (auto-fit); a lone tile (Connect QuickBooks) keeps one tile's width (auto-fill keeps the empty tracks).
const FIT_COLUMNS = "md:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]";
const LONE_COLUMNS = "md:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]";
const TONE = { danger: "text-danger", success: "text-success" } as const;

/** No tiles: nothing (a role that cannot connect and has no finance view must not be told about finance figures). */
export function KpiStrip({ laneId, tiles }: { laneId: string; tiles: KpiTile[] }) {
  if (tiles.length === 0) return null;
  return (
    <section aria-labelledby="kpi-heading" data-testid="home-kpis" className={`grid grid-cols-2 items-stretch gap-3 md:gap-5 ${tiles.length === 1 ? LONE_COLUMNS : FIT_COLUMNS}`}>
      <h2 id="kpi-heading" className="sr-only">Key figures</h2>
      {tiles.map((t) => (t.connect ? <ConnectTile key={t.key} laneId={laneId} tile={t} /> : <Tile key={t.key} tile={t} />))}
    </section>
  );
}

function ConnectTile({ laneId, tile }: { laneId: string; tile: KpiTile }) {
  // Same shape as a figure tile: label, a short line, then the link text (the whole tile is the link).
  return (
    <Link
      href={`${laneHref(laneId, "settings")}#connections`}
      data-testid="kpi-connect"
      className={`flex h-full min-w-0 flex-col justify-between gap-2 rounded-card border border-border bg-card p-5 text-card-foreground shadow-card hover:bg-muted/40 ${TILE_HEIGHT}`}
    >
      <p className="font-sans text-label font-medium uppercase tracking-wide text-muted-foreground">QuickBooks</p>
      <p className="text-small text-muted-foreground">Cash, bills and net income show here once connected.</p>
      <p className="font-sans text-small font-semibold text-primary">
        {tile.label} <span aria-hidden>{"\u2192"}</span>
      </p>
    </Link>
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
