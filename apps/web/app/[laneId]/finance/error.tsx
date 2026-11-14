"use client";
// T-245: a failure outside the per-card boundaries (header, period links, data loading) shows this instead of the generic error page.
// No error message, digest or figure is shown; the error is already logged by Next on the server.
import { EmptyState, PageHeader } from "@nichols/ui";

export default function FinanceError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Finance" accent="at a glance" />
      <EmptyState
        title="Finance could not load"
        description="Something went wrong while showing this page. Try again, or reload in a minute."
        action={
          <button type="button" onClick={reset} className="rounded-control border border-border px-3 py-2 text-body font-medium hover:bg-accent">
            Try again
          </button>
        }
      />
    </div>
  );
}
