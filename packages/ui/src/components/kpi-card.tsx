import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { BookBalanceLabel } from "./book-balance";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./card";
import { SourceChip, type SourceChipProps } from "./source-chip";

/** Matches `FinanceResult.status` (docs/specs/finance.md §7). */
export type KpiStatus = "ok" | "pending_definition" | "no_data";

const DEFAULT_STATUS_TEXT: Record<Exclude<KpiStatus, "ok">, string> = {
  pending_definition: "Pending definition",
  no_data: "No data yet",
};

export type KpiCardProps = {
  label: string;
  /** Heading level of the label; defaults to h3. */
  headingLevel?: "h2" | "h3" | "h4";
  /** Pre-formatted display figure (formatted server-side). Shown only when status is "ok"; missing or "" means no data. */
  value?: string;
  /** Short qualifier under the label, e.g. "month to date". */
  qualifier?: string;
  /** Cash card: shows the mandatory "Book balance" label. */
  bookBalance?: boolean;
  status?: KpiStatus;
  /**
   * Replaces the default text for "pending_definition" / "no_data". The finance dashboard (T-095)
   * passes "Pending definition (D-3)" for the customer churn card while its status is pending_definition.
   */
  statusText?: string;
  sources?: SourceChipProps[];
  /** Extra content under the source chips (e.g. a link to the detail view). */
  footer?: ReactNode;
  className?: string;
};

export function KpiCard({
  label,
  headingLevel,
  value,
  qualifier,
  bookBalance = false,
  status = "ok",
  statusText,
  sources = [],
  footer,
  className,
}: KpiCardProps) {
  const effectiveStatus: KpiStatus = status === "ok" && (value === undefined || value === "") ? "no_data" : status;

  return (
    <Card data-slot="kpi-card" data-status={effectiveStatus} className={cn("min-w-0", className)}>
      <CardHeader>
        <CardTitle as={headingLevel} className="font-sans text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {bookBalance || qualifier ? (
          <div className="flex flex-wrap items-center gap-2">
            {bookBalance ? <BookBalanceLabel /> : null}
            {qualifier ? <span className="text-xs text-muted-foreground">{qualifier}</span> : null}
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        {effectiveStatus === "ok" ? (
          <p data-slot="kpi-value" className="font-heading text-3xl font-semibold tabular-nums text-foreground">
            {value}
          </p>
        ) : (
          <p data-slot="kpi-status" className="text-sm font-medium text-muted-foreground">
            {statusText ?? DEFAULT_STATUS_TEXT[effectiveStatus]}
          </p>
        )}
      </CardContent>
      {sources.length > 0 || footer ? (
        <CardFooter>
          {sources.map((s, i) => (
            <SourceChip key={`${s.source}-${i}`} {...s} />
          ))}
          {footer}
        </CardFooter>
      ) : null}
    </Card>
  );
}
