// "Temporary: connection test" (T-198, for the Nov 12 QuickBooks sandbox run; replaced by the connection health page, T-045).
// Rendered only for owner or admin_technical at AAL2 when the lane switched it on (see settings-page.tsx), under
// Settings -> Developer tools, collapsed until opened (T-230 B). "Connect QuickBooks" starts the existing T-050 connect
// flow; "Check connection" runs one read-only health check. Only these two actions.
import { buttonVariants } from "@nichols/ui";
import { ConnectionCheckButton } from "./connection-check-button";

export function ConnectionTestSection({ laneId }: { laneId: string }) {
  return (
    <section id="developer-tools" aria-labelledby="developer-tools-title" className="scroll-mt-8">
      <div className="flex flex-col gap-4 rounded-card border border-border bg-card p-5 text-body text-card-foreground shadow-card sm:p-6">
        <div className="flex flex-col gap-1">
          <h2 id="developer-tools-title" className="font-heading text-card-title font-semibold">
            Developer tools
          </h2>
          <p className="text-secondary text-muted-foreground">For checking connections before the real connection page exists. Collapsed by default.</p>
        </div>
        <details data-testid="connection-test" className="rounded-control border border-border bg-background">
          <summary className="flex min-h-11 cursor-pointer items-center px-4 font-medium text-foreground">Temporary: connection test</summary>
          <div className="flex flex-col gap-4 border-t border-border p-4">
            <p className="text-secondary text-muted-foreground">For testing the QuickBooks connection before the real connection page exists. Nothing is changed in QuickBooks.</p>
            {/* A same-origin form POST: the route checks the origin, the role and AAL2, then sends you to Intuit. */}
            <div className="flex flex-wrap items-start gap-3">
              <form method="post" action={`/api/connect/qbo/start?lane=${encodeURIComponent(laneId)}`}>
                <button type="submit" className={buttonVariants({ variant: "default" })}>
                  Connect QuickBooks
                </button>
              </form>
              <ConnectionCheckButton laneId={laneId} />
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}
