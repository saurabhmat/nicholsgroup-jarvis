// "Your Google accounts" and the other accounts' health, Settings -> Connections (T-199, restyled in T-230 B; T-247). Shown to a member who may
// connect their own Google account at AAL2 (owner, admin_technical, viewer; see settings-page.tsx). Your own accounts have the buttons;
// another person's account is listed for health only (owner and admin_technical, the connections view) and has none: only its owner
// reconnects it. "Connect Google" / "Connect another Google account" start the existing T-063 flow with a same-origin form POST:
// the route checks the origin, the role and AAL2, then sends you to Google's consent page. T-238: every row has its OWN "Reconnect"
// (the same flow bound to that connection: the callback accepts only that row's account, replaces its tokens and never creates a
// second row). It is the primary button for a row that needs it (reconnect needed, disconnected, with problems) and an outline
// button on a healthy row (to refresh access, for example to grant a new permission). "Sync now" is no longer here: it is one provider-neutral bar in connections-section.tsx (T-270). There is no Disconnect button (D-24).
import { Alert, AlertDescription, AlertTitle, Badge, buttonVariants } from "@nichols/ui";
import type { GoogleConnectionState, GoogleSectionView } from "@/lib/google-connection";
import { ConnectionRow, when } from "./connection-rows";

const LABEL: Record<GoogleConnectionState, { text: string; variant: "success" | "alert" | "muted" }> = {
  connected: { text: "Connected", variant: "success" },
  connecting: { text: "Connecting", variant: "muted" },
  degraded: { text: "Connected, with problems", variant: "alert" },
  reconnect_required: { text: "Reconnect needed", variant: "alert" },
  disconnected: { text: "Disconnected", variant: "alert" },
};

const needsReconnect = (view: GoogleSectionView) => !view.paused && view.connections.some((c) => c.state === "reconnect_required" || c.state === "disconnected");
/** The states in which Reconnect is the main action of the row. */
const URGENT: ReadonlySet<GoogleConnectionState> = new Set(["reconnect_required", "disconnected", "degraded"]);

export function GoogleNotices({ view }: { view: GoogleSectionView }) {
  return (
    <>
      {needsReconnect(view) ? (
        <Alert variant="alert">
          <AlertTitle>Google needs to be reconnected</AlertTitle>
          <AlertDescription>Google access was revoked or has expired, so mail and calendar are no longer syncing. Use the Reconnect button on the account below.</AlertDescription>
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

/** T-257: Google is not enabled for this company (any more): its rows are kept and shown as paused, with no Connect and no Reconnect. */
export const GOOGLE_PAUSED_TEXT = "Paused: Google is not enabled for this company";

function GooglePausedRows({ view }: { view: GoogleSectionView }) {
  return (
    <>
      {view.connections.map((c) => (
        <ConnectionRow
          key={c.id}
          testId={c.mine ? "google-connection" : "google-other-connection"}
          provider={c.mine ? "Your Google account" : "Google"}
          sub={c.mine ? "Mail, calendar and Drive, read-only" : "Another person's account: status only"}
          account={c.mailbox}
          status={<Badge variant="muted">{GOOGLE_PAUSED_TEXT}</Badge>}
          lastSync={
            <>
              <span className="block">Mail: {when(c.lastMailSyncAt)}</span>
              <span className="block">Calendar: {when(c.lastCalendarSyncAt)}</span>
            </>
          }
          actions={null}
          note={<>Nothing was deleted: the connection and its data are kept, and syncing is paused.</>}
        />
      ))}
    </>
  );
}

export function GoogleRows({ laneId, view }: { laneId: string; view: GoogleSectionView }) {
  if (view.paused) return <GooglePausedRows view={view} />;
  const start = `/api/connect/google/start?lane=${encodeURIComponent(laneId)}`;
  const mine = view.connections.filter((c) => c.mine);
  const others = view.connections.filter((c) => !c.mine);
  const connected = mine.some((c) => c.state !== "disconnected");
  const button = view.unavailable ? null : (
    <form method="post" action={start}>
      <button type="submit" className={buttonVariants({ variant: connected ? "outline" : "default" })}>
        {connected ? "Connect another Google account" : "Connect Google"}
      </button>
    </form>
  );
  const reconnectButton = (c: GoogleSectionView["connections"][number]) => (
    <form method="post" action={`${start}&connection=${encodeURIComponent(c.id)}`}>
      <button type="submit" aria-label={`Reconnect ${c.mailbox}`} className={buttonVariants({ variant: URGENT.has(c.state) ? "default" : "outline" })}>
        Reconnect
      </button>
    </form>
  );
  const sub = "Mail, calendar and Drive, read-only";
  const otherRows = others.map((c) => (
    <ConnectionRow
      key={c.id}
      testId="google-other-connection"
      provider="Google"
      sub="Another person's account: status only"
      account={c.mailbox}
      status={<Badge variant={LABEL[c.state].variant}>{LABEL[c.state].text}</Badge>}
      lastSync={
        <>
          <span className="block">Mail: {when(c.lastMailSyncAt)}</span>
          <span className="block">Calendar: {when(c.lastCalendarSyncAt)}</span>
        </>
      }
      actions={null}
      note={<>Only the person who connected this account can reconnect it. The portal shows you its status, never its mail or calendar.</>}
    />
  ));
  if (mine.length === 0) {
    return (
      <>
        <ConnectionRow
          testId="google-not-connected"
          provider="Your Google accounts"
          sub={sub}
          account={<span className="text-muted-foreground">Not connected</span>}
          status={<Badge variant="muted">Not connected</Badge>}
          lastSync="Not synced yet"
          actions={button}
        />
        {otherRows}
      </>
    );
  }
  return (
    <>
      {mine.map((c, i) => (
        <ConnectionRow
          key={c.id}
          testId="google-connection"
          provider="Your Google account"
          sub={sub}
          account={c.mailbox}
          status={<Badge variant={LABEL[c.state].variant}>{LABEL[c.state].text}</Badge>}
          lastSync={
            <>
              <span className="block">Mail: {when(c.lastMailSyncAt)}</span>
              <span className="block">Calendar: {when(c.lastCalendarSyncAt)}</span>
            </>
          }
          actions={
            view.unavailable ? null : (
              <>
                {reconnectButton(c)}
                {i === mine.length - 1 ? button : null}
              </>
            )
          }
          note={!c.mailboxAllowed ? <>This account is not on a domain this company allows, so it is not syncing. Ask your administrator.</> : null}
        />
      ))}
      {otherRows}
    </>
  );
}

export function GoogleNotes() {
  return (
    <div className="text-small text-muted-foreground">
      <p>
        Each Google account belongs to the person who connected it: its mail, calendar and drafts are visible only to them, and you connect your own accounts yourself. Google is read-only: the portal cannot send, change or delete anything in Google, and this is not how anyone signs in to the portal.{" "}
        <span className="font-medium text-foreground">Removing the portal&apos;s access:</span> disconnecting from this page is not available yet; revoking access will be an approval action. To remove access now, use Google Account → Security → Third-party
        connections, or, for a Workspace account, the Admin console app access controls.
      </p>
    </div>
  );
}
