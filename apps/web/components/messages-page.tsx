// Messages (T-280, spec docs/specs/messages.md 11 "States"): the connect states of the signed-in person's own Teams account in this company. No chat data yet: a connected person sees
// who they are connected as and a placeholder where the chat list arrives (T-283); no sample data. Every state has a fixed text (rule 9: nothing from Teams, the config or the query is
// rendered), and none shows an empty list on an error. T-276: the header is fixed text and the lane check streams in the eyebrow; the connect state is read beside the module gate
// (`startMessages`), and nothing here reads the clock or calls Microsoft (a link prefetch makes no Graph request: there is no Graph read on this page yet).
import Link from "next/link";
import { cache, Suspense } from "react";
import { Alert, AlertDescription, AlertTitle, buttonVariants, Card, CardDescription, CardHeader, CardTitle, EmptyState, laneHref, PageHeader } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { messagesStateOf, type MessagesState } from "@/lib/teams-messages";
import { teamsSectionFor } from "@/lib/teams-connection";
import { reconnectToAddText, TEAMS_ADMIN_CONSENT_TEXT, TEAMS_CLOUD_UNSUPPORTED_PAGE_TEXT, TEAMS_CONNECTS_TEXT, TEAMS_NOT_SET_UP_TEXT, TEAMS_PAUSED_PAGE_TEXT } from "@/lib/teams-wording";
import { LaneEyebrow } from "./module-page";
import { CardSkeleton } from "./page-skeleton";

/** One read per request and lane, shared by the gate's early start and the body (React cache). */
const messagesState = cache(async (laneId: string): Promise<MessagesState> => {
  const g = await guards();
  return messagesStateOf(await teamsSectionFor(g, laneId, undefined, undefined, { keepEmpty: true }));
});

/** Called by the route page beside the module gate: begins the read. A failure is reported where the body awaits it; the no-op catch only prevents an unhandled rejection if the gate redirects first. */
export function startMessages(params: Promise<{ laneId: string }>): void {
  void params.then((p) => messagesState(p.laneId)).catch(() => undefined);
}

export function MessagesPage({ params }: { params: Promise<{ laneId: string }> }) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={<LaneEyebrow params={params} />} title="Messages" />
      <Suspense fallback={<CardSkeleton />}>
        <MessagesBody params={params} />
      </Suspense>
    </div>
  );
}

async function MessagesBody({ params }: { params: Promise<{ laneId: string }> }) {
  const laneId = (await params).laneId;
  return <MessagesScreen laneId={laneId} state={await messagesState(laneId)} />;
}

function SignIn({ laneId, connectionId, label }: { laneId: string; connectionId?: string; label: string }) {
  const action = `/api/connect/teams/start?lane=${encodeURIComponent(laneId)}${connectionId ? `&connection=${encodeURIComponent(connectionId)}` : ""}`;
  return (
    <form method="post" action={action}>
      <button type="submit" className={buttonVariants({ variant: "default" })}>
        {label}
      </button>
    </form>
  );
}

/** The page below the header, for a given state (the tests render this directly). */
export function MessagesScreen({ laneId, state }: { laneId: string; state: MessagesState }) {
  switch (state.kind) {
    case "no_access":
    case "not_enabled":
      return <EmptyState title="Messages are not set up" description={TEAMS_NOT_SET_UP_TEXT} />;
    case "paused":
      return <EmptyState title="Teams is paused" description={state.unsupportedCloud ? TEAMS_CLOUD_UNSUPPORTED_PAGE_TEXT : TEAMS_PAUSED_PAGE_TEXT} />;
    case "unavailable":
      return (
        <Alert variant="alert" data-testid="messages-unavailable">
          <AlertTitle>Teams could not be reached</AlertTitle>
          <AlertDescription>The portal could not read your Teams connection just now. Reload the page in a minute.</AlertDescription>
        </Alert>
      );
    case "not_connected":
      return (
        <Card data-testid="messages-not-connected">
          <CardHeader>
            <CardTitle as="h2">Sign in to Teams</CardTitle>
            <CardDescription>{TEAMS_CONNECTS_TEXT}</CardDescription>
          </CardHeader>
          <div className="px-6 pb-6">
            <SignIn laneId={laneId} label="Sign in to Teams" />
          </div>
        </Card>
      );
    case "reconnect":
      return (
        <Card data-testid="messages-reconnect">
          <CardHeader>
            <CardTitle as="h2">Your Teams sign-in expired</CardTitle>
            <CardDescription>Reconnect Teams to see your chats again.</CardDescription>
          </CardHeader>
          <div className="px-6 pb-6">
            <SignIn laneId={laneId} connectionId={state.connectionId} label="Reconnect Teams" />
          </div>
        </Card>
      );
    case "connected":
      return (
        <div className="flex flex-col gap-4" data-testid="messages-connected">
          <Card>
            <CardHeader>
              <CardTitle as="h2">Connected as {state.account}</CardTitle>
              <CardDescription>
                Your Teams account is connected.{" "}
                <Link href={`${laneHref(laneId, "settings")}#connections`} className="font-medium underline underline-offset-4">
                  Manage it in Settings
                </Link>
                .
              </CardDescription>
            </CardHeader>
          </Card>
          {state.degraded ? (
            <Alert variant="alert" data-testid="messages-degraded">
              <AlertTitle>Teams is having problems</AlertTitle>
              <AlertDescription>The last check of your Teams connection failed. If it keeps happening, reconnect Teams in Settings.</AlertDescription>
            </Alert>
          ) : null}
          {state.missing.length > 0 ? (
            <Alert data-testid="messages-feature-missing">
              <AlertDescription>
                {reconnectToAddText(state.missing)}
                {state.adminConsent ? ` ${TEAMS_ADMIN_CONSENT_TEXT}` : ""}
              </AlertDescription>
              <div className="pt-2">
                <SignIn laneId={laneId} connectionId={state.connectionId} label="Reconnect Teams" />
              </div>
            </Alert>
          ) : null}
          <EmptyState title="Chats arrive in the next update" description="Your Teams chats will be listed here. Nothing is stored: chats are read from Teams when you open them." />
        </div>
      );
  }
}
