import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export type ErrorStateProps = {
  title: string;
  description?: string;
  /** e.g. a "Try again" button or link. */
  action?: ReactNode;
  /** "alert" (default) interrupts screen readers; use "status" for errors that are not urgent. */
  role?: "alert" | "status";
  className?: string;
};

/** Shown in place of a region whose content failed to load. Messages come from the caller; never pass raw error details. */
export function ErrorState({ title, description, action, role = "alert", className }: ErrorStateProps) {
  return (
    <div
      data-slot="error-state"
      role={role}
      className={cn(
        "flex flex-col items-center gap-2 rounded-card border border-alert bg-alert-surface px-6 py-10 text-center text-alert-foreground",
        className,
      )}
    >
      <p className="font-heading text-lg font-semibold">{title}</p>
      {description ? <p className="max-w-prose text-sm">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
