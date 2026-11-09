// "Composio" rows of Settings -> Connections (T-219, restyled in T-230 B). Shown only to owner or admin_technical at AAL2
// (see settings-page.tsx). "Connect via Composio" / "Reconnect via Composio" are same-origin form POSTs to the start route;
// Test is a read-only check; Disconnect is shown disabled until the Approval Center exists (an external write, D-24).
// When the toolkit's auth config id is not set on the server the button says "Not configured: X is not set" and does
// nothing; when the project key itself is not set (nothing can be connected) one line says so instead of per-toolkit rows.
// Setting NAMES only, never values (T-226). The chat only links here.
import { Alert, AlertDescription, AlertTitle, Badge, buttonVariants, cn } from "@nichols/ui";
import type { ComposioConnectionState, ComposioSectionView } from "@/lib/composio-connection";
import { ComposioTestButton } from "./composio-test-button";
import { ConnectionRow, when } from "./connection-rows";

const LABEL: Record<ComposioConnectionState, { text: string; variant: "success" | "alert" | "muted" }> = {
  connected: { text: "Connected", variant: "success" },
  connecting: { text: "Connecting", variant: "muted" },
  degraded: { text: "Connected, with problems", variant: "alert" },
  reconnect_required: { text: "Reconnect needed", variant: "alert" },
};

/** "Not configured: A is not set" / "Not configured: A, B are not set": setting NAMES only; plain "Not configured" when unknown. */
// Setting names such as COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID (38 characters, no spaces) are wider than the cell at
// phone width: let the label break inside a name and keep the button within its container (H-042: horizontal scroll).
export const NOT_CONFIGURED_CLASS = "h-auto min-w-0 max-w-full shrink whitespace-normal text-left [overflow-wrap:anywhere]";

export function notConfigured(missing: readonly string[] | undefined): string {
  const names = missing ?? [];
  return names.length === 0 ? "Not configured" : `Not configured: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} not set`;
}

export const KEY_NAME = "COMPOSIO_API_KEY";
export const NOT_CONFIGURED_ON_SERVER = `Composio not configured on this server (${KEY_NAME} not set)`;

/** True when no toolkit can be connected because the project key is missing and nothing is connected: one line then. */
export function composioNotConfigured(view: ComposioSectionView): boolean {
  return view.toolkits.length > 0 && view.toolkits.every((t) => !t.configured && t.connection === null && (t.missing ?? []).includes(KEY_NAME));
}

export function ComposioNotices({ view }: { view: ComposioSectionView }) {
  return view.unavailable ? (
    <Alert variant="alert">
      <AlertTitle>Composio connection status is unavailable</AlertTitle>
      <AlertDescription>The portal could not read the connection status just now. Reload the page in a minute; if it keeps happening, contact support.</AlertDescription>
    </Alert>
  ) : null;
}

export function ComposioRows({ laneId, view }: { laneId: string; view: ComposioSectionView }) {
  if (composioNotConfigured(view)) {
    return (
      <li data-testid="composio-not-configured" className="py-3 text-body text-muted-foreground">
        {NOT_CONFIGURED_ON_SERVER}
      </li>
    );
  }
  return (
    <>
      {view.toolkits.map((t) => {
        const c = t.connection;
        const needsReconnect = c?.state === "reconnect_required";
        const action = `/api/connect/composio/start?lane=${encodeURIComponent(laneId)}&toolkit=${encodeURIComponent(t.toolkit)}`;
        const connectLabel = needsReconnect ? "Reconnect via Composio" : c ? "Replace account via Composio" : "Connect via Composio";
        const note =
          needsReconnect || (c?.address && !c.mailboxAllowed) ? (
            <>
              {needsReconnect ? (
                <Alert variant="alert">
                  <AlertTitle>{t.label} needs to be reconnected</AlertTitle>
                  <AlertDescription>Composio reports this account as expired or revoked. Use Reconnect via Composio.</AlertDescription>
                </Alert>
              ) : null}
              {c?.address && !c.mailboxAllowed ? <p>This address is not in the company&apos;s mailbox list, so it is not used. Ask your administrator to add it.</p> : null}
            </>
          ) : null;
        return (
          <ConnectionRow
            key={t.toolkit}
            testId={`composio-${t.toolkit}`}
            provider="Composio"
            sub={t.label}
            account={c ? (c.address ?? "waiting for the connection to finish") : <span className="text-muted-foreground">Not connected</span>}
            status={c ? <Badge variant={LABEL[c.state].variant}>{LABEL[c.state].text}</Badge> : <Badge variant="muted">Not connected</Badge>}
            lastSync={c ? when(c.lastSyncAt) : "Not synced yet"}
            actions={
              view.unavailable ? null : (
                <>
                  {t.configured ? (
                    <form method="post" action={action}>
                      <button type="submit" className={buttonVariants({ variant: c && !needsReconnect ? "outline" : "default" })}>
                        {connectLabel}
                      </button>
                    </form>
                  ) : (
                    <button type="button" disabled aria-disabled="true" title="Not configured on this server yet" className={cn(buttonVariants({ variant: "outline" }), NOT_CONFIGURED_CLASS)}>
                      {notConfigured(t.missing)}
                    </button>
                  )}
                  {c && c.state !== "connecting" ? <ComposioTestButton laneId={laneId} toolkit={t.toolkit} /> : null}
                  {c ? (
                    <button type="button" disabled aria-disabled="true" title="Disconnect arrives with Approvals" className={buttonVariants({ variant: "outline" })}>
                      Disconnect
                    </button>
                  ) : null}
                </>
              )
            }
            note={note}
          />
        );
      })}
    </>
  );
}

export function ComposioNotes({ view }: { view: ComposioSectionView }) {
  if (composioNotConfigured(view)) return null;
  return (
    <div className="flex flex-col gap-1 text-small text-muted-foreground">
      <p>
        Composio connects a Gmail mailbox and a Google Calendar and holds the Google access. Only addresses in this company&apos;s mailbox list are accepted. Until this company is switched to Composio, mail and calendar keep syncing through the Google
        connection; connecting here does not change that. Only one account per service per company is used: connecting a new one replaces the account here, and the previous account stays in Composio until it is removed by hand.
      </p>
      <p>
        <span className="font-medium text-foreground">Removing access:</span> Disconnect arrives with Approvals: removing an account changes another system, so it will be an approval action. Until then, remove the account in the Composio dashboard
        (Connected accounts), and, if you want, remove the app&apos;s access in your Google Account → Security → Third-party connections.
      </p>
    </div>
  );
}
