// "Google" rows of Settings -> Connections (T-199, restyled in T-230 B). Shown only to owner or admin_technical at AAL2
// (see settings-page.tsx). "Connect Google" / "Reconnect Google" start the existing T-063 flow with a same-origin form POST:
// the route checks the origin, the role and AAL2, then sends you to Google's consent page. There is no Disconnect button (D-24).
import { Alert, AlertDescription, AlertTitle, Badge, buttonVariants } from "@nichols/ui";
import type { GoogleConnectionState, GoogleSectionView } from "@/lib/google-connection";
import { ConnectionRow, when } from "./connection-rows";

const LABEL: Record<GoogleConnectionState, { text: string; variant: "success" | "alert" | "muted" }> = {
  connected: { text: "Connected", variant: "success" },
  connecting: { text: "Connecting", variant: "muted" },
  degraded: { text: "Connected, with problems", variant: "alert" },
  reconnect_required: { text: "Reconnect needed", variant: "alert" },
};

const needsReconnect = (view: GoogleSectionView) => view.connections.some((c) => c.state === "reconnect_required");

export function GoogleNotices({ view }: { view: GoogleSectionView }) {
  return (
    <>
      {needsReconnect(view) ? (
        <Alert variant="alert">
          <AlertTitle>Google needs to be reconnected</AlertTitle>
          <AlertDescription>Google access was revoked or has expired, so mail and calendar are no longer syncing. Use Reconnect Google below.</AlertDescription>
        </Alert>
      ) : null}
      {view.unavailable ? (
        <Alert variant="alert">
          <AlertTitle>Google connection status is unavailable</AlertTitle>
          <AlertDescription>The portal could not read the connection status just now. Reload the page in a minute; if it keeps happening, contact support.</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

export function GoogleRows({ laneId, view }: { laneId: string; view: GoogleSectionView }) {
  const action = `/api/connect/google/start?lane=${encodeURIComponent(laneId)}`;
  const reconnect = needsReconnect(view);
  const connected = view.connections.length > 0;
  const button = view.unavailable ? null : (
    <form method="post" action={action}>
      <button type="submit" className={buttonVariants({ variant: connected && !reconnect ? "outline" : "default" })}>
        {reconnect ? "Reconnect Google" : connected ? "Connect another Google account" : "Connect Google"}
      </button>
    </form>
  );
  const sub = "Mail, calendar and Drive, read-only";
  if (!connected) {
    return (
      <ConnectionRow
        testId="google-not-connected"
        provider="Google"
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
          testId="google-connection"
          provider="Google"
          sub={sub}
          account={c.mailbox}
          status={<Badge variant={LABEL[c.state].variant}>{LABEL[c.state].text}</Badge>}
          lastSync={
            <>
              <span className="block">Mail: {when(c.lastMailSyncAt)}</span>
              <span className="block">Calendar: {when(c.lastCalendarSyncAt)}</span>
            </>
          }
          actions={i === view.connections.length - 1 ? button : null}
          note={!c.mailboxAllowed ? <>This mailbox is not in the lane&apos;s mailbox list, so it is not syncing. Ask your administrator to add it.</> : null}
        />
      ))}
    </>
  );
}

export function GoogleNotes() {
  return (
    <div className="text-secondary text-muted-foreground">
      <p>
        Google is read-only: the portal cannot send, change or delete anything in Google, and this is not how anyone signs in to the portal.{" "}
        <span className="font-medium text-foreground">Removing the portal&apos;s access:</span> disconnecting from this page is not available yet; revoking access will be an approval action. To remove access now, use Google Account → Security → Third-party
        connections, or, for a Workspace account, the Admin console app access controls.
      </p>
    </div>
  );
}
