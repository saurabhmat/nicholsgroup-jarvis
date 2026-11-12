import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { EmptyState } from "./empty-state";

export type PageSectionProps = {
  /** Card title, as in the prototype ("Today's briefing"). */
  title: string;
  /** Short note beside the title (for example the sources line). */
  note?: string;
  /** Heading level; defaults to h2 (the page header holds the h1). */
  headingLevel?: "h2" | "h3";
  /** Empty-state text shown until the module supplies content. */
  emptyTitle?: string;
  emptyDescription?: string;
  /** Real content; replaces the empty state. */
  children?: ReactNode;
  className?: string;
};

/** A titled card for one page section. With no children it shows the T-022 empty state (no data, no sample label). */
export function PageSection({ title, note, headingLevel: Heading = "h2", emptyTitle, emptyDescription, children, className }: PageSectionProps) {
  return (
    <section data-slot="page-section" aria-label={title} className={cn("flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-6 text-body text-card-foreground shadow-card", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading className="font-heading text-card-title font-semibold text-foreground">{title}</Heading>
        {note ? <p className="text-small text-muted-foreground">{note}</p> : null}
      </div>
      {children ?? <EmptyState title={emptyTitle ?? "Nothing to show yet"} description={emptyDescription} className="border-0 bg-transparent px-0 py-6" />}
    </section>
  );
}
