// Settings -> Connections: Coverage per source (T-234 part 1; it was a card on Home). One row per mail or calendar source
// the caller may see: account, last sync, status chip and a FIXED reason when it is not OK (codes only, names only; never
// provider text). The state is a word in the chip, never colour alone.
import { Badge } from "@nichols/ui";
import { ago, formatTimeIn, type CoverageItem } from "@nichols/briefing/domain";
import type { CoverageView } from "@/lib/coverage";

const STATE_BADGE: Record<CoverageItem["state"], { label: string; variant: "success" | "alert" | "muted" | "outline" }> = {
  ok: { label: "OK", variant: "success" },
  stale: { label: "Stale", variant: "outline" },
  error: { label: "Error", variant: "alert" },
  not_connected: { label: "Not connected", variant: "muted" },
};

export function CoverageList({ view, tz, now }: { view: CoverageView; tz: string; now: Date }) {
  return (
    <div data-testid="coverage-list" className="flex flex-col gap-2 border-t border-border px-6 py-4">
      <h3 className="font-heading text-card-title font-semibold text-foreground">Coverage</h3>
      <p className="text-small text-muted-foreground">What each source last synced. Mail and calendar the briefing and Home read from.</p>
      {view.unavailable ? (
        <p data-testid="coverage-unavailable" className="text-small text-muted-foreground">
          Coverage could not be checked right now. Reload in a minute.
        </p>
      ) : view.items.length === 0 ? (
        <p data-testid="coverage-empty" className="text-small text-muted-foreground">
          No mailbox or calendar is set up for this company yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {view.items.map((c) => {
            const badge = STATE_BADGE[c.state];
            return (
              <li key={`${c.stream}:${c.account}`} data-testid="coverage-item" data-state={c.state} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-body">
                <span className="w-20 shrink-0 text-muted-foreground">{c.stream === "mail" ? "Mail" : "Calendar"}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{c.account}</span>
                <span className="text-small text-muted-foreground">{c.lastSyncAt ? `Synced ${formatTimeIn(c.lastSyncAt, tz)} (${ago(c.lastSyncAt, now)})` : "Never synced"}</span>
                <Badge variant={badge.variant}>{badge.label}</Badge>
                {c.reason ? <span className="basis-full text-small text-muted-foreground">{c.reason}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
