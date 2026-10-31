import { cn } from "../lib/utils";
import { Badge } from "./badge";

/** Matches `FinanceResult.freshness` (docs/specs/finance.md §7); thresholds live in lane_config. */
export type Freshness = "live" | "cached" | "stale";

const FRESHNESS: Record<Freshness, { label: string; variant: "success" | "secondary" | "alert" }> = {
  live: { label: "Live", variant: "success" },
  cached: { label: "Cached", variant: "secondary" },
  stale: { label: "Stale", variant: "alert" },
};

export function FreshnessBadge({ freshness, className }: { freshness: Freshness; className?: string }) {
  const { label, variant } = FRESHNESS[freshness];
  return (
    <Badge variant={variant} data-freshness={freshness} className={className}>
      {label}
    </Badge>
  );
}

export type SourceChipProps = {
  /** Display name of the source, e.g. "QuickBooks". */
  source: string;
  freshness: Freshness;
  /** Pre-formatted as-of display string (formatted server-side). */
  asOf: string;
  /** Optional ISO-8601 timestamp for a machine-readable `<time>`. */
  asOfDateTime?: string;
  className?: string;
};

/** Where a figure comes from, how fresh it is, and when it was true. Freshness is shown in text, not colour alone. */
export function SourceChip({ source, freshness, asOf, asOfDateTime, className }: SourceChipProps) {
  return (
    <span
      data-slot="source-chip"
      data-freshness={freshness}
      className={cn(
        "inline-flex flex-wrap items-center gap-1.5 rounded-control border border-border bg-card px-2 py-1 text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="font-medium text-foreground">{source}</span>
      <FreshnessBadge freshness={freshness} />
      <span className="tabular-nums">
        as of {asOfDateTime ? <time dateTime={asOfDateTime}>{asOf}</time> : <span>{asOf}</span>}
      </span>
    </span>
  );
}
