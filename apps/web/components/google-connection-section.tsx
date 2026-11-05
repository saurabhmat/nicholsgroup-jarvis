// "Google" on Settings → Connections (T-199). Shown only to owner or admin_technical at AAL2 (see settings-page.tsx).
// "Connect Google" / "Reconnect Google" start the existing T-063 flow with a same-origin form POST: the route checks the
// origin, the role and AAL2, then sends you to Google's consent page. There is no Disconnect button (D-24).
import { Alert, AlertDescription, AlertTitle, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, buttonVariants } from "@nichols/ui";
import type { GoogleConnectionState, GoogleSectionView } from "@/lib/google-connection";

const LABEL: Record<GoogleConnectionState, { text: string; variant: "success" | "alert" | "muted" }> = {
  connected: { text: "Connected", variant: "success" },
  connecting: { text: "Connecting", variant: "muted" },
  degraded: { text: "Connected, with problems", variant: "alert" },
  reconnect_required: { text: "Reconnect needed", variant: "alert" },
};

const TIME = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
const when = (iso: string | null) => (iso ? `${TIME.format(new Date(iso))} ET` : "not synced yet");

export function GoogleConnectionSection({ laneId, view }: { laneId: string; view: GoogleSectionView }) {
  const action = `/api/connect/google/start?lane=${encodeURIComponent(laneId)}`;
  const needsReconnect = view.connections.some((c) => c.state === "reconnect_required");
  const connected = view.connections.length > 0;
  return (
    <section aria-labelledby="google-connection-title">
      <Card>
        <CardHeader>
          <CardTitle as="h2" id="google-connection-title">
            Google
          </CardTitle>
          <CardDescription>
            Connects the lane&apos;s mail, calendar and Drive to the portal, read-only. The portal cannot send, change or delete anything in Google. This is not how anyone signs in to the portal.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {needsReconnect ? (
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
          {view.connections.map((c) => (
            <dl key={c.id} data-testid="google-connection" className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Mailbox</dt>
              <dd>{c.mailbox}</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <Badge variant={LABEL[c.state].variant}>{LABEL[c.state].text}</Badge>
              </dd>
              <dt className="text-muted-foreground">Last mail sync</dt>
              <dd>{when(c.lastMailSyncAt)}</dd>
              <dt className="text-muted-foreground">Last calendar sync</dt>
              <dd>{when(c.lastCalendarSyncAt)}</dd>
              {!c.mailboxAllowed ? (
                <>
                  <dt className="text-muted-foreground">Note</dt>
                  <dd>This mailbox is not in the lane&apos;s mailbox list, so it is not syncing. Ask your administrator to add it.</dd>
                </>
              ) : null}
            </dl>
          ))}
          {view.unavailable ? null : (
            <form method="post" action={action}>
              <button type="submit" className={buttonVariants({ variant: connected && !needsReconnect ? "outline" : "default" })}>
                {needsReconnect ? "Reconnect Google" : connected ? "Connect another Google account" : "Connect Google"}
              </button>
            </form>
          )}
          <div className="text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Removing the portal&apos;s access</p>
            <p>
              Disconnecting from this page is not available yet; revoking access will be an approval action. To remove access now, use Google Account → Security → Third-party connections, or, for a Workspace account, the
              Admin console app access controls.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
