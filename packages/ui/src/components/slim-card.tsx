import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export type SlimCardProps = {
  /** The region's accessible name (the card's own title, e.g. "GovCon news"). */
  title: string;
  /** One line of text; may hold a link. */
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
};

/**
 * A card for a source that is switched off or not connected (T-235 part 5): one line of 13px text in the same white 12px-radius
 * bordered card as the others, with a 12px vertical padding, so it never takes the space a card with content would.
 */
export function SlimCard({ title, children, className, "data-testid": testId }: SlimCardProps) {
  return (
    <section data-slot="slim-card" data-testid={testId} aria-label={title} className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-card border border-border bg-card px-6 py-3 text-small text-muted-foreground shadow-card", className)}>
      {children}
    </section>
  );
}
