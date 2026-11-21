// "Your Microsoft accounts" and the other accounts' health, Settings -> Connections (T-257; spec docs/specs/microsoft.md §5.5, §7). Drawn next to
// "Your Google accounts", which is unchanged. Same shape as the Google rows: your own accounts have Connect / Reconnect / Disconnect; another
// person's account is health only (owner and admin_technical, the connections view) and has no button: only its owner reconnects or disconnects it.
// A paused section (Microsoft not enabled for this company) keeps its rows with no Connect or Reconnect; Disconnect stays for the owner.
// Text is fixed here: nothing from the query string, the config or a provider is rendered (rule 9). Presentational: the loaders decide what shows.
import { Alert, AlertDescription, AlertTitle, Badge, buttonVariants } from "@nichols/ui";
import type { GoogleConnectionState } from "@/lib/google-connection";
import type { MicrosoftSectionView } from "@/lib/microsoft-connection";
import { ConnectionRow, when } from "./connection-rows";
import { MicrosoftDisconnectButton } from "./microsoft-disconnect-button";

export const MICROSOFT_PAUSED_TEXT = "Paused: Microsoft is not enabled for this company";

const LABEL: Record<GoogleConnectionState, { text: string; variant: "success" | "alert" | "muted" }> = {
  connected: { text: "Connected", variant: "success" },
  connecting: { text: "Connecting", variant: "muted" },
  degraded: { text: "Connected, with problems", variant: "alert" },
  reconnect_required: { text: "Reconnect needed", variant: "alert" },
  disconnected: { text: "Disconnected", variant: "alert" },
};
const URGENT: ReadonlySet<GoogleConnectionState> = new Set(["reconnect_required", "disconnected", "degraded"]);

export function MicrosoftNotices({ view }: { view: MicrosoftSectionView }) {
  return (
    <>
      {!view.paused && view.connections.some((c) => c.mine && (c.state === "reconnect_required" || c.state === "disconnected")) ? (
        <Alert variant="alert">
          <AlertTitle>Microsoft needs to be reconnected</AlertTitle>
          <AlertDescription>Microsoft access was revoked or has expired, so mail and calendar are no longer syncing. Use the Reconnect button on the account below.</AlertDescription>
        </Alert>
      ) : null}
      {view.unavailable ? (
        <Alert variant="alert" data-testid="microsoft-unavailable">
          <AlertTitle>Microsoft connection status is unavailable</AlertTitle>
          <AlertDescription>The portal could not read the connection status just now. Reload the page in a minute; if it keeps happening, contact support.</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

export function MicrosoftRows({ laneId, view }: { laneId: string; view: MicrosoftSectionView }) {
  if (view.unavailable) return null;
  const paused = view.paused === true;
  const start = `/api/connect/microsoft/start?lane=${encodeURIComponent(laneId)}`;
  const mine = view.connections.filter((c) => c.mine);
  const others = view.connections.filter((c) => !c.mine);
  const connected = mine.some((c) => c.state !== "disconnected");
  const sub = "Mail and calendar, read-only";
  const status = (c: MicrosoftSectionView["connections"][number]) => (paused ? <Badge variant="muted">{MICROSOFT_PAUSED_TEXT}</Badge> : <Badge variant={LABEL[c.state].variant}>{LABEL[c.state].text}</Badge>);
  const syncCell = (c: MicrosoftSectionView["connections"][number]) => (
    <>
      <span className="block">Mail: {when(c.lastMailSyncAt)}</span>
      <span className="block">Calendar: {when(c.lastCalendarSyncAt)}</span>
    </>
  );
  const connectButton = paused ? null : (
    <form method="post" action={start}>
      <button type="submit" className={buttonVariants({ variant: connected ? "outline" : "default" })}>
        {connected ? "Connect another Microsoft account" : "Connect Microsoft"}
      </button>
    </form>
  );
  const reconnect = (c: MicrosoftSectionView["connections"][number]) =>
    paused ? null : (
      <form method="post" action={`${start}&connection=${encodeURIComponent(c.id)}`}>
        <button type="submit" aria-label={`Reconnect ${c.mailbox}`} className={buttonVariants({ variant: URGENT.has(c.state) ? "default" : "outline" })}>
          Reconnect
        </button>
      </form>
    );
  const otherRows = others.map((c) => (
    <ConnectionRow
      key={c.id}
      testId="microsoft-other-connection"
      provider="Microsoft"
      sub="Another person's account: status only"
      account={c.mailbox}
      status={status(c)}
      lastSync={syncCell(c)}
      actions={null}
      note={<>Only the person who connected this account can reconnect or disconnect it. The portal shows you its status, never its mail or calendar.</>}
    />
  ));
  if (mine.length === 0) {
    if (paused) return <>{otherRows}</>;
    return (
      <>
        <ConnectionRow testId="microsoft-not-connected" provider="Your Microsoft accounts" sub={sub} account={<span className="text-muted-foreground">Not connected</span>} status={<Badge variant="muted">Not connected</Badge>} lastSync="Not synced yet" actions={connectButton} />
        {otherRows}
      </>
    );
  }
  return (
    <>
      {mine.map((c, i) => (
        <ConnectionRow
          key={c.id}
          testId="microsoft-connection"
          provider="Your Microsoft account"
          sub={sub}
          account={c.mailbox}
          status={status(c)}
          lastSync={syncCell(c)}
          actions={
            <>
              {reconnect(c)}
              {c.state !== "disconnected" ? <MicrosoftDisconnectButton laneId={laneId} connectionId={c.id} mailbox={c.mailbox} /> : null}
              {i === mine.length - 1 ? connectButton : null}
            </>
          }
          note={
            paused ? (
              <>Nothing was deleted: the connection and its data are kept, and syncing is paused. You can still disconnect it.</>
            ) : !c.mailboxAllowed ? (
              <>This account is not on a domain this company allows, so it is not syncing. Ask your administrator.</>
            ) : null
          }
        />
      ))}
      {otherRows}
    </>
  );
}

export function MicrosoftNotes({ view }: { view: MicrosoftSectionView }) {
  if (view.unavailable) return null;
  return (
    <div className="flex flex-col gap-2 text-small text-muted-foreground" data-testid="microsoft-notes">
      <p>
        This connects your Microsoft 365 mail and calendar, read-only, and is not how anyone signs in to the portal. Each Microsoft account belongs to the person who connected it: its mail and calendar are visible only to them, and you connect your own accounts yourself.{" "}
        <span className="font-medium text-foreground">Removing the portal&apos;s access:</span> Disconnect deletes the access the portal stored and does not contact Microsoft, so Microsoft may still list the app. You or your Microsoft 365 administrator can remove the
        app&apos;s access in your Microsoft account or in the Entra admin center (Enterprise apps → the app → Permissions).
      </p>
      {view.adminConsentUrl ? (
        <p data-testid="microsoft-admin-consent">
          If Microsoft says your organisation&apos;s administrator must approve the app, send them this link:{" "}
          <a href={view.adminConsentUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground underline underline-offset-4">
            Administrator approval link
          </a>
          . It only asks for the read-only mail and calendar permissions above; the administrator approves at Microsoft and the portal stores nothing.
        </p>
      ) : null}
    </div>
  );
}
