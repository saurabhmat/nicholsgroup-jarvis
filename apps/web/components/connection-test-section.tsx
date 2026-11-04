// "Temporary: connection test" (T-198, for the Nov 12 QuickBooks sandbox run; replaced by the connection health page, T-045).
// Rendered only for owner or admin_technical at AAL2 when the lane switched it on (see settings-page.tsx). "Connect
// QuickBooks" starts the existing T-050 connect flow; "Check connection" runs one read-only health check. Only these two actions.
import { Card, CardContent, CardDescription, CardHeader, CardTitle, buttonVariants } from "@nichols/ui";
import { ConnectionCheckButton } from "./connection-check-button";

export function ConnectionTestSection({ laneId }: { laneId: string }) {
  return (
    <Card aria-labelledby="connection-test-title">
      <CardHeader>
        <CardTitle as="h2" id="connection-test-title">
          Temporary: connection test
        </CardTitle>
        <CardDescription>For testing the QuickBooks connection before the real connection page exists. Nothing is changed in QuickBooks.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* A same-origin form POST: the route checks the origin, the role and AAL2, then sends you to Intuit. */}
        <form method="post" action={`/api/connect/qbo/start?lane=${encodeURIComponent(laneId)}`}>
          <button type="submit" className={buttonVariants({ variant: "default" })}>
            Connect QuickBooks
          </button>
        </form>
        <ConnectionCheckButton laneId={laneId} />
      </CardContent>
    </Card>
  );
}
