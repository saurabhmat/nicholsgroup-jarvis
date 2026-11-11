// "QuickBooks" row of Settings -> Connections (T-233; it took over the connection test of T-198).
// Shown only to owner or admin_technical at AAL2 (see settings-page.tsx). "Connect QuickBooks" / "Reconnect QuickBooks"
// start the existing T-050 flow with a same-origin form POST (the route checks the origin, the role and AAL2, then sends you
// to Intuit). "Check connection" is the read-only health check. There is no button to remove the connection (D-24); nothing is
// written to QuickBooks.
import { Alert, AlertDescription, AlertTitle, Badge, buttonVariants } from "@nichols/ui";
import type { QuickBooksConnectionState, QuickBooksSectionView } from "@/lib/quickbooks-connection";
import { ConnectionCheckButton } from "./connection-check-button";
import { ConnectionRow, when } from "./connection-rows";

const LABEL: Record<QuickBooksConnectionState, { text: string; variant: "success" | "alert" | "muted" }> = {
  connected: { text: "Connected", variant: "success" },
  connecting: { text: "Connecting", variant: "muted" },
  degraded: { text: "Connected, with problems", variant: "alert" },
  reconnect_required: { text: "Reconnect needed", variant: "alert" },
};

const needsReconnect = (view: QuickBooksSectionView) => view.connections.some((c) => c.state === "reconnect_required");

export function QuickBooksNotices({ view }: { view: QuickBooksSectionView }) {
  return (
    <>
      {needsReconnect(view) ? (
        <Alert variant="alert">
          <AlertTitle>QuickBooks needs to be reconnected</AlertTitle>
          <AlertDescription>QuickBooks access was withdrawn or has expired, so the books are no longer syncing. Use Reconnect QuickBooks below.</AlertDescription>
        </Alert>
      ) : null}
      {view.unavailable ? (
        <Alert variant="alert">
          <AlertTitle>QuickBooks connection status is unavailable</AlertTitle>
          <AlertDescription>The portal could not read the connection status just now. Reload the page in a minute; if it keeps happening, contact support.</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

export function QuickBooksRows({ laneId, view }: { laneId: string; view: QuickBooksSectionView }) {
  const action = `/api/connect/qbo/start?lane=${encodeURIComponent(laneId)}`;
  const reconnect = needsReconnect(view);
  const connected = view.connections.length > 0;
  const sub = "Books, read-only";
  const button = view.unavailable ? null : (
    <form method="post" action={action}>
      <button type="submit" className={buttonVariants({ variant: connected && !reconnect ? "outline" : "default" })}>
        {connected ? "Reconnect QuickBooks" : "Connect QuickBooks"}
      </button>
    </form>
  );
  if (!connected) {
    return (
      <ConnectionRow
        testId="quickbooks-not-connected"
        provider="QuickBooks"
        sub={sub}
        account={<span className="text-muted-foreground">Not connected</span>}
        status={<Badge variant="muted">Not connected</Badge>}
        lastSync="Not synced yet"
        actions={button}
      />
    );
  }
  return (
    <>
      {view.connections.map((c, i) => (
        <ConnectionRow
          key={c.id}
          testId="quickbooks-connection"
          provider="QuickBooks"
          sub={sub}
          account={<span>Company ID {c.realmId}</span>}
          status={<Badge variant={LABEL[c.state].variant}>{LABEL[c.state].text}</Badge>}
          lastSync={when(c.lastSyncAt)}
          actions={
            i === view.connections.length - 1 ? (
              <div className="flex flex-col gap-3">
                {button}
                {c.state === "reconnect_required" ? null : <ConnectionCheckButton laneId={laneId} />}
              </div>
            ) : null
          }
        />
      ))}
    </>
  );
}

export function QuickBooksNotes() {
  return (
    <div className="text-small text-muted-foreground">
      <p>QuickBooks is read-only: the portal cannot post, change or delete anything in QuickBooks. Check connection makes one read-only request and changes nothing.</p>
    </div>
  );
}
