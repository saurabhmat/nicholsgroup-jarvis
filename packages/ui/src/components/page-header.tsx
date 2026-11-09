import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export type PageHeaderProps = {
  /** Small line above the title: date and company on Home, a context line elsewhere. */
  eyebrow?: ReactNode;
  /** Serif heading text. */
  title: string;
  /** Italic accent word(s) after the title (the prototype's "at a glance"). */
  accent?: string;
  /** Right-hand controls (Ask Jarvis, the period toggle). */
  actions?: ReactNode;
  className?: string;
};

/**
 * The shared page header: eyebrow, serif H1 with an italic accent, optional actions. On iPhone the navy header band
 * shows the title (aria-hidden), so the H1 is visually hidden below md but stays in the accessibility tree.
 */
export function PageHeader({ eyebrow, title, accent, actions, className }: PageHeaderProps) {
  return (
    <header data-slot="page-header" className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        {eyebrow ? <p data-slot="page-eyebrow" className="text-secondary text-muted-foreground">{eyebrow}</p> : null}
        <h1 className="sr-only font-heading text-page-title font-semibold text-foreground md:not-sr-only">
          {title}
          {accent ? (
            <>
              {" "}
              <em data-slot="accent" className="font-normal italic text-accent-italic">
                {accent}
              </em>
            </>
          ) : null}
        </h1>
      </div>
      {actions ? <div className="flex items-center gap-3">{actions}</div> : null}
    </header>
  );
}
