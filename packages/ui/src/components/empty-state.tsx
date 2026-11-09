import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
};

/** Placeholder for a region with nothing to show yet. */
export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      role="status"
      className={cn(
        "flex flex-col items-center gap-2 rounded-card border border-dashed border-border bg-card px-6 py-10 text-center",
        className,
      )}
    >
      <p className="font-heading text-card-title font-semibold text-foreground">{title}</p>
      {description ? <p className="max-w-prose text-body text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
