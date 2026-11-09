import type { ReactNode } from "react";
import { cn, mailtoHref } from "../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "./alert";

export type ErrorBannerProps = {
  title: string;
  description?: string;
  /** Adds a "Contact support" mailto link. Ignored unless it is a plain email address. */
  supportEmail?: string;
  supportSubject?: string;
  supportLabel?: string;
  /** e.g. a "Reconnect" button or form. */
  action?: ReactNode;
  /** "alert" (default) interrupts screen readers; use "status" for errors that are not urgent. */
  role?: "alert" | "status";
  className?: string;
};

/** Page-level error banner, source-agnostic (T-197 uses it for QuickBooks connection errors). */
export function ErrorBanner({
  title,
  description,
  supportEmail,
  supportSubject,
  supportLabel = "Contact support",
  action,
  role = "alert",
  className,
}: ErrorBannerProps) {
  const supportHref = supportEmail ? mailtoHref(supportEmail, supportSubject) : undefined;

  return (
    <Alert data-slot="error-banner" role={role} variant="alert" className={cn("sm:flex sm:items-start sm:justify-between sm:gap-4", className)}>
      <div className="grid gap-1">
        <AlertTitle>{title}</AlertTitle>
        {description ? <AlertDescription>{description}</AlertDescription> : null}
      </div>
      {action || supportHref ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 sm:mt-0">
          {action}
          {supportHref ? (
            <a href={supportHref} className="text-body font-medium underline underline-offset-4">
              {supportLabel}
            </a>
          ) : null}
        </div>
      ) : null}
    </Alert>
  );
}
