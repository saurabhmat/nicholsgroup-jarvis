import { cn } from "../lib/utils";

/** Rule 7 (CLAUDE.md): cash figures from the books are always labelled "book balance". */
export const BOOK_BALANCE_LABEL = "Book balance";

/** The fixed "Book balance" label. It takes no text so it cannot be relabelled. */
export function BookBalanceLabel({ className }: { className?: string }) {
  return (
    <span data-slot="book-balance-label" className={cn("text-small font-medium uppercase tracking-wide text-muted-foreground", className)}>
      {BOOK_BALANCE_LABEL}
    </span>
  );
}

export type BookBalanceProps = {
  /** Pre-formatted figure (formatted server-side), shown as is, including negatives. */
  value: string;
  /** Optional account display name. */
  accountName?: string;
  className?: string;
};

/** A cash figure with its mandatory "Book balance" label. */
export function BookBalance({ value, accountName, className }: BookBalanceProps) {
  return (
    <dl data-slot="book-balance" className={cn("flex flex-col gap-0.5", className)}>
      <dt className="flex flex-wrap items-baseline gap-2">
        <BookBalanceLabel />
        {accountName ? <span className="text-body text-foreground">{accountName}</span> : null}
      </dt>
      <dd className="text-card-title font-semibold tabular-nums text-foreground">{value}</dd>
    </dl>
  );
}
