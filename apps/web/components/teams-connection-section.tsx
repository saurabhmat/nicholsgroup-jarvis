// "Your Teams account" and other people's Teams health, Settings -> Connections (T-280; spec docs/specs/messages.md 5, 11). Drawn beside the Google and Microsoft sections, which are
// unchanged. Your own row has Sign in / Reconnect / Disconnect; another person's account is health only (owner and admin_technical, the connections view) and has no button: only its
// owner reconnects or disconnects it. A paused section keeps its rows with no Sign in or Reconnect; Disconnect stays for the owner. Text is fixed in lib/teams-wording.ts: nothing
// from the query string, the config or a provider is rendered (rule 9). Presentational: the loader decides what shows.
import { Alert, AlertDescription, AlertTitle, Badge, buttonVariants } from "@nichols/ui";
import type { GoogleConnectionState } from "@/lib/google-connection";
import type { TeamsConnectionView, TeamsSectionView } from "@/lib/teams-connection";
import { reconnectToAddText, TEAMS_ADMIN_CONSENT_TEXT, TEAMS_CONNECTS_TEXT, TEAMS_PAUSED_TEXT, TEAMS_REMOVE_ACCESS_TEXT } from "@/lib/teams-wording";
import { ConnectionRow } from "./connection-rows";
import { TeamsDisconnectButton } from "./teams-disconnect-button";

const LABEL: Record<GoogleConnectionState, { text: string; variant: "success" | "alert" | "muted" }> = {
  connected: { text: "Connected", variant: "success" },
  connecting: { text: "Connecting", variant: "muted" },
  degraded: { text: "Connected, with problems", variant: "alert" },
  reconnect_required: { text: "Reconnect needed", variant: "alert" },
  disconnected: { text: "Disconnected", variant: "alert" },
};
const URGENT: ReadonlySet<GoogleConnectionState> = new Set(["reconnect_required", "disconnected", "degraded"]);

export function TeamsNotices({ view }: { view: TeamsSectionView }) {
  return (
    <>
      {!view.paused && !view.settingsUnknown && view.connections.some((c) => c.mine && c.state === "reconnect_required") ? (
        <Alert variant="alert" data-testid="teams-reconnect-notice">
          <AlertTitle>Teams needs to be reconnected</AlertTitle>
          <AlertDescription>Your Teams sign-in expired or was revoked. Use the Reconnect button on your Teams account below.</AlertDescription>
        </Alert>
      ) : null}
      {view.settingsUnknown ? (
        <Alert variant="alert" data-testid="teams-settings-unknown">
          <AlertTitle>Teams settings could not be read</AlertTitle>
          <AlertDescription>The portal could not check this company&apos;s Teams settings just now, so Sign in and Reconnect are unavailable. Reload the page in a minute.</AlertDescription>
        </Alert>
      ) : null}
      {view.unavailable ? (
        <Alert variant="alert" data-testid="teams-unavailable">
          <AlertTitle>Teams connection status is unavailable</AlertTitle>
          <AlertDescription>The portal could not read the connection status just now. Reload the page in a minute; if it keeps happening, contact support.</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

const featureNote = (view: TeamsSectionView, c: TeamsConnectionView) => reconnectToAddText(view.laneFeatures.filter((f) => !c.has.includes(f)));

export function TeamsRows({ laneId, view }: { laneId: string; view: TeamsSectionView }) {
  if (view.unavailable) return null;
  const locked = view.paused === true || view.settingsUnknown === true; // no Sign in, no Reconnect
  const start = `/api/connect/teams/start?lane=${encodeURIComponent(laneId)}`;
  const mine = view.connections.filter((c) => c.mine);
  const others = view.connections.filter((c) => !c.mine);
  const hasActive = mine.some((c) => c.state !== "disconnected");
  const status = (c: TeamsConnectionView) => (view.paused ? <Badge variant="muted">{TEAMS_PAUSED_TEXT}</Badge> : <Badge variant={LABEL[c.state].variant}>{LABEL[c.state].text}</Badge>);
  const features = (c: TeamsConnectionView) => <span className="block text-small text-muted-foreground">{c.has.length === 0 ? "No features yet" : `Has: ${c.has.map((f) => f.replace("_", " ")).join(", ")}`}</span>;
  const signIn = locked || hasActive ? null : (
    <form method="post" action={start}>
      <button type="submit" className={buttonVariants({ variant: "default" })}>
        Sign in to Teams
      </button>
    </form>
  );
  const reconnect = (c: TeamsConnectionView) =>
    locked ? null : (
      <form method="post" action={`${start}&connection=${encodeURIComponent(c.id)}`}>
        <button type="submit" aria-label={`Reconnect ${c.account}`} className={buttonVariants({ variant: URGENT.has(c.state) ? "default" : "outline" })}>
          Reconnect
        </button>
      </form>
    );
  const otherRows = others.map((c) => (
    <ConnectionRow
      key={c.id}
      testId="teams-other-connection"
      provider="Teams"
      sub="Another person's account: status only"
      account={c.account}
      status={status(c)}
      lastSync="No sync: chats are read live"
      actions={null}
      note={<>Only the person who connected this account can reconnect or disconnect it. The portal shows you its status, never its chats.</>}
    />
  ));
  if (mine.length === 0) {
    if (locked) return <>{otherRows}</>;
    return (
      <>
        <ConnectionRow testId="teams-not-connected" provider="Your Teams account" sub="Chats and calls, read live" account={<span className="text-muted-foreground">Not connected</span>} status={<Badge variant="muted">Not connected</Badge>} lastSync="No sync: chats are read live" actions={signIn} />
        {otherRows}
      </>
    );
  }
  return (
    <>
      {mine.map((c, i) => (
        <ConnectionRow
          key={c.id}
          testId="teams-connection"
          provider="Your Teams account"
          sub="Chats and calls, read live"
          account={
            <>
              {c.account}
              {features(c)}
            </>
          }
          status={status(c)}
          lastSync="No sync: chats are read live"
          actions={
            <>
              {reconnect(c)}
              {c.state !== "disconnected" ? <TeamsDisconnectButton laneId={laneId} connectionId={c.id} account={c.account} /> : null}
              {i === mine.length - 1 ? signIn : null}
            </>
          }
          note={
            view.paused ? (
              <>Nothing was deleted: the connection is kept and Teams is paused. You can still disconnect it.</>
            ) : view.settingsUnknown ? (
              <>Sign in and Reconnect are unavailable until the company&apos;s Teams settings can be read. You can still disconnect it.</>
            ) : c.state !== "disconnected" && featureNote(view, c) ? (
              <span data-testid="teams-feature-note">{featureNote(view, c)}</span>
            ) : null
          }
        />
      ))}
      {otherRows}
    </>
  );
}

export function TeamsNotes({ view }: { view: TeamsSectionView }) {
  if (view.unavailable) return null;
  return (
    <div className="flex flex-col gap-2 text-small text-muted-foreground" data-testid="teams-notes">
      <p>
        {TEAMS_CONNECTS_TEXT} Each Teams account belongs to the person who connected it, and you sign in to your own. <span className="font-medium text-foreground">Removing the portal&apos;s access:</span> {TEAMS_REMOVE_ACCESS_TEXT}
      </p>
      {view.needsAdminConsent ? <p data-testid="teams-admin-consent">If Microsoft says an administrator must approve the app: {TEAMS_ADMIN_CONSENT_TEXT}</p> : null}
    </div>
  );
}
