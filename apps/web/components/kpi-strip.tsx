// Home KPI strip (T-234 part 1): five equal compact tiles in one row from lg (two columns on a phone). Every tile has the
// same three rows (label, figure, note), a minimum height and `h-full`, so a tile with a figure and a "Not connected ·
// Connect" tile are the same height. Cash always carries the "Book balance" label (rule 7). No figure is ever invented.
import Link from "next/link";
import { BookBalanceLabel, laneHref } from "@nichols/ui";
import type { KpiTile } from "@/lib/home-kpi-tiles";

export const TILE_HEIGHT = "min-h-[7.75rem]";

export function KpiStrip({ laneId, tiles }: { laneId: string; tiles: KpiTile[] }) {
  return (
    <section aria-label="Key figures" data-testid="home-kpis" className="grid grid-cols-2 items-stretch gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((t) => (
        <Tile key={t.key} laneId={laneId} tile={t} />
      ))}
    </section>
  );
}

function Tile({ laneId, tile }: { laneId: string; tile: KpiTile }) {
  const has = tile.value !== undefined && tile.value !== "";
  return (
    <div data-slot="kpi-tile" data-testid="kpi-tile" data-kpi={tile.key} data-status={has ? "ok" : tile.connect ? "not_connected" : "no_data"} className={`flex h-full min-w-0 flex-col justify-between gap-2 rounded-card border border-border bg-card p-4 text-card-foreground shadow-card ${TILE_HEIGHT}`}>
      <div className="flex min-h-10 flex-col gap-0.5">
        <h2 className="font-sans text-small font-medium text-muted-foreground">{tile.label}</h2>
        {tile.bookBalance ? <BookBalanceLabel className="text-[0.6875rem]" /> : null}
      </div>
      {has ? (
        <p data-slot="kpi-value" className="font-heading text-card-title font-semibold tabular-nums text-foreground">
          {tile.value}
        </p>
      ) : (
        <p data-slot="kpi-value" aria-label="No figure" className="font-heading text-card-title font-semibold text-muted-foreground">
          <span aria-hidden>{"—"}</span>
        </p>
      )}
      <p data-slot="kpi-note" className="line-clamp-2 min-h-8 text-small text-muted-foreground" title={tile.note}>
        {tile.connect && !has ? (
          <>
            Not connected {"·"}{" "}
            <Link href={`${laneHref(laneId, "settings")}#connections`} className="font-medium text-primary underline-offset-2 hover:underline">
              Connect
            </Link>
          </>
        ) : (
          tile.note
        )}
      </p>
    </div>
  );
}
