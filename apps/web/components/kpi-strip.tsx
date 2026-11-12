// Home KPI strip (T-234 part 1): five equal compact tiles in one row from lg (two columns on a phone). Every tile has the
// same three rows (label, figure, note), a minimum height and `h-full`, so a tile with a figure and a "Not connected ·
// Connect" tile are the same height. Cash always carries the "Book balance" label (rule 7). No figure is ever invented.
import Link from "next/link";
import { BookBalanceLabel, laneHref } from "@nichols/ui";
import type { KpiTile } from "@/lib/home-kpi-tiles";

export const TILE_HEIGHT = "min-h-[9rem]";

// Static class names (Tailwind needs them whole): the strip fits its tiles, five in the normal case.
const COLS: Record<number, string> = { 1: "sm:grid-cols-1 lg:grid-cols-1", 2: "sm:grid-cols-2 lg:grid-cols-2", 3: "sm:grid-cols-3 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4", 5: "sm:grid-cols-3 lg:grid-cols-5" };

export const NONE_CONNECTED_TEXT = "Connect QuickBooks, Stripe and GoHighLevel to see cash, AR, P&L, MRR and subscribers";

/**
 * Tiles only for connected sources, filling the row equally (one column on a phone). With none: one slim banner with a
 * Settings link for owner / admin_technical (`canConnect`); any other role sees nothing (they cannot connect anything and a
 * banner they cannot act on is noise; a role without finance access must not be told about finance figures at all).
 */
export function KpiStrip({ laneId, tiles, canConnect = false }: { laneId: string; tiles: KpiTile[]; canConnect?: boolean }) {
  if (tiles.length === 0) {
    if (!canConnect) return null;
    return (
      <section aria-label="Key figures" data-testid="home-kpis-banner" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card border border-border bg-card px-4 py-2 text-small text-foreground shadow-card">
        <span className="min-w-0">{NONE_CONNECTED_TEXT}</span>
        <Link href={`${laneHref(laneId, "settings")}#connections`} className="shrink-0 font-medium text-primary underline underline-offset-2">
          <span aria-hidden>{"\u2192 "}</span>Settings
        </Link>
      </section>
    );
  }
  return (
    <section aria-label="Key figures" data-testid="home-kpis" className={`grid grid-cols-1 items-stretch gap-4 ${COLS[tiles.length] ?? COLS[5] ?? ""}`}>
      {tiles.map((t) => (
        <Tile key={t.key} laneId={laneId} tile={t} canConnect={canConnect} />
      ))}
    </section>
  );
}

function Tile({ laneId, tile, canConnect }: { laneId: string; tile: KpiTile; canConnect: boolean }) {
  const has = tile.value !== undefined && tile.value !== "";
  return (
    <div data-slot="kpi-tile" data-testid="kpi-tile" data-kpi={tile.key} data-status={has ? "ok" : tile.connect ? "not_connected" : "no_data"} className={`flex h-full min-w-0 flex-col justify-between gap-2 rounded-card border border-border bg-card p-4 text-card-foreground shadow-card ${TILE_HEIGHT}`}>
      <div className="flex min-h-10 flex-col gap-0.5">
        <h2 className="font-sans text-small font-medium text-muted-foreground">{tile.label}</h2>
        {tile.bookBalance ? <BookBalanceLabel className="text-[0.6875rem]" /> : null}
        {tile.qualifier ? <p className="text-[0.6875rem] text-muted-foreground">{tile.qualifier}</p> : null}
      </div>
      {has ? (
        <p data-slot="kpi-value" className="min-w-0 break-words font-heading text-card-title font-semibold tabular-nums text-foreground">
          {tile.value}
        </p>
      ) : (
        <p data-slot="kpi-value" className="font-heading text-card-title font-semibold text-muted-foreground">
          {/* aria-label is not allowed on a plain paragraph (axe aria-prohibited-attr): the dash is hidden, the words are read. */}
          <span aria-hidden>{"—"}</span>
          <span className="sr-only">No figure</span>
        </p>
      )}
      <div data-slot="kpi-note" className="flex min-h-12 flex-col gap-0.5 text-small text-muted-foreground">
        {tile.flags.map((f) => (
          <p key={f} data-slot="kpi-flag" className="font-medium text-foreground">
            {f}
          </p>
        ))}
        {tile.connect && !has ? (
          <p>
            Not connected
            {canConnect ? (
              <>
                {" \u00b7 "}
                <Link href={`${laneHref(laneId, "settings")}#connections`} className="font-medium text-primary underline-offset-2 hover:underline">
                  Connect
                </Link>
              </>
            ) : null}
          </p>
        ) : tile.note ? (
          <p>{tile.note}</p>
        ) : null}
      </div>
    </div>
  );
}
