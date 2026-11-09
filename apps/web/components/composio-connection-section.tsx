// "Composio" on Settings → Connections (T-219). Shown only to owner or admin_technical at AAL2 (see settings-page.tsx).
// "Connect via Composio" / "Reconnect via Composio" are same-origin form POSTs to the start route; Test is a read-only
// check; Disconnect is shown disabled until the Approval Center exists (an external write, D-24). When the toolkit's auth
// config id is not set on the server the button says "Not configured" and does nothing. The chat only links here.
import { Alert, AlertDescription, AlertTitle, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, buttonVariants } from "@nichols/ui";
import type { ComposioConnectionState, ComposioSectionView } from "@/lib/composio-connection";
import { ComposioTestButton } from "./composio-test-button";

const LABEL: Record<ComposioConnectionState, { text: string; variant: "success" | "alert" | "muted" }> = {
  connected: { text: "Connected", variant: "success" },
  connecting: { text: "Connecting", variant: "muted" },
  degraded: { text: "Connected, with problems", variant: "alert" },
  reconnect_required: { text: "Reconnect needed", variant: "alert" },
};

const TIME = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
const when = (iso: string | null) => (iso ? `${TIME.format(new Date(iso))} ET` : "not synced yet");

/** "Not configured: A is not set" / "Not configured: A, B are not set": setting NAMES only; plain "Not configured" when unknown. */
export function notConfigured(missing: readonly string[] | undefined): string {
  const names = missing ?? [];
  return names.length === 0 ? "Not configured" : `Not configured: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} not set`;
}

export function ComposioConnectionSection({ laneId, view }: { laneId: string; view: ComposioSectionView }) {
  return (
    <section id="composio-connections" aria-labelledby="composio-connection-title" className="scroll-mt-4">
      <Card>
        <CardHeader>
          <CardTitle as="h2" id="composio-connection-title">
            Composio (Gmail and Calendar)
          </CardTitle>
          <CardDescription>
            Connects a Gmail mailbox and a Google Calendar through Composio, which holds the Google access. Only addresses in this company&apos;s mailbox list are accepted. Until this company is switched to Composio, mail and calendar keep syncing
            through the Google connection above; connecting here does not change that.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {view.unavailable ? (
            <Alert variant="alert">
              <AlertTitle>Composio connection status is unavailable</AlertTitle>
              <AlertDescription>The portal could not read the connection status just now. Reload the page in a minute; if it keeps happening, contact support.</AlertDescription>
            </Alert>
          ) : null}
          {view.toolkits.map((t) => {
            const c = t.connection;
            const needsReconnect = c?.state === "reconnect_required";
            const action = `/api/connect/composio/start?lane=${encodeURIComponent(laneId)}&toolkit=${encodeURIComponent(t.toolkit)}`;
            const connectLabel = needsReconnect ? "Reconnect via Composio" : c ? "Replace account via Composio" : "Connect via Composio";
            return (
              <div key={t.toolkit} data-testid={`composio-${t.toolkit}`} className="flex flex-col gap-3 border-t pt-4 first:border-t-0 first:pt-0">
                <h3 className="text-base font-medium">{t.label}</h3>
                {needsReconnect ? (
                  <Alert variant="alert">
                    <AlertTitle>{t.label} needs to be reconnected</AlertTitle>
                    <AlertDescription>Composio reports this account as expired or revoked. Use Reconnect via Composio below.</AlertDescription>
                  </Alert>
                ) : null}
                {c ? (
                  <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Account</dt>
                    <dd>{c.address ?? "waiting for the connection to finish"}</dd>
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>
                      <Badge variant={LABEL[c.state].variant}>{LABEL[c.state].text}</Badge>
                    </dd>
                    <dt className="text-muted-foreground">Last sync</dt>
                    <dd>{when(c.lastSyncAt)}</dd>
                    {c.address && !c.mailboxAllowed ? (
                      <>
                        <dt className="text-muted-foreground">Note</dt>
                        <dd>This address is not in the company&apos;s mailbox list, so it is not used. Ask your administrator to add it.</dd>
                      </>
                    ) : null}
                  </dl>
                ) : (
                  <p className="text-sm text-muted-foreground">Not connected.</p>
                )}
                {c && c.state !== "connecting" ? (
                  <p className="text-sm text-muted-foreground">Only one account per service per company is used. Connecting a new one replaces this account here; the previous account stays in Composio until it is removed by hand.</p>
                ) : null}
                {view.unavailable ? null : (
                  <div className="flex flex-wrap items-start gap-3">
                    {t.configured ? (
                      <form method="post" action={action}>
                        <button type="submit" className={buttonVariants({ variant: c && !needsReconnect ? "outline" : "default" })}>
                          {connectLabel}
                        </button>
                      </form>
                    ) : (
                      <button type="button" disabled aria-disabled="true" title="Not configured on this server yet" className={buttonVariants({ variant: "outline", className: "h-auto whitespace-normal text-left" })}>
                        {notConfigured(t.missing)}
                      </button>
                    )}
                    {c && c.state !== "connecting" ? <ComposioTestButton laneId={laneId} toolkit={t.toolkit} /> : null}
                    {c ? (
                      <button type="button" disabled aria-disabled="true" title="Disconnect arrives with Approvals" className={buttonVariants({ variant: "outline" })}>
                        Disconnect
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
          <div className="text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Removing access</p>
            <p>
              Disconnect arrives with Approvals: removing an account changes another system, so it will be an approval action. Until then, remove the account in the Composio dashboard (Connected accounts), and, if you want, remove the
              app&apos;s access in your Google Account → Security → Third-party connections.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
