// Messages (T-280, T-283; spec docs/specs/messages.md 11 "States"): the connect states of the signed-in person's own Teams account in this company, and, for a connected person, their chat
// list and conversation (components/messages-chats.tsx). No sample data. Every state has a fixed text (rule 9: nothing from the config or the query is rendered), and none shows an empty
// list on an error. T-276: the header is fixed text and the lane check streams in the eyebrow; the connect state is read beside the module gate (`startMessages`); the Graph reads (the chat
// list and the open conversation) start together in the workspace, which renders only after the gate and the connect state, inside Suspense, so a link prefetch makes no Graph request and this
// file reads no clock and imports no Microsoft client.
import Link from "next/link";
import { cache, Suspense, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle, Card, CardDescription, CardHeader, CardTitle, EmptyState, laneHref, PageHeader } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { messagesStateOf, type MessagesState } from "@/lib/teams-messages";
import { teamsSectionFor } from "@/lib/teams-connection";
import { reconnectToAddText, TEAMS_ADMIN_CONSENT_TEXT, TEAMS_CLOUD_UNSUPPORTED_PAGE_TEXT, TEAMS_CONNECTS_TEXT, TEAMS_NOT_SET_UP_TEXT, TEAMS_PAUSED_PAGE_TEXT } from "@/lib/teams-wording";
import { LaneEyebrow } from "./module-page";
import { MessagesWorkspace } from "./messages-chats";
import { decodeChatKey } from "@/lib/teams-chat-key";
import { SignIn } from "./messages-view";
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

type SearchParams = Record<string, string | string[] | undefined>;

export function MessagesPage({ params, searchParams }: { params: Promise<{ laneId: string }>; searchParams: Promise<SearchParams> }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader eyebrow={<LaneEyebrow params={params} />} title="Messages" />
      <Suspense fallback={<CardSkeleton />}>
        <MessagesBody params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function MessagesBody({ params, searchParams }: { params: Promise<{ laneId: string }>; searchParams: Promise<SearchParams> }) {
  const laneId = (await params).laneId;
  const state = await messagesState(laneId);
  const chat = (await searchParams)?.chat;
  const chatOpen = state.kind === "connected" && decodeChatKey(typeof chat === "string" ? chat : null) !== null;
  return <MessagesScreen laneId={laneId} state={state} chatOpen={chatOpen} workspace={state.kind === "connected" ? <ConnectedWorkspace laneId={laneId} state={state} searchParams={searchParams} /> : null} />;
}

/** Chats need the company's `chat_read` and the connection's: otherwise the page says so (the "Reconnect Teams to add chats" note is the connected card's), never an empty list. */
function ConnectedWorkspace({ laneId, state, searchParams }: { laneId: string; state: Extract<MessagesState, { kind: "connected" }>; searchParams: Promise<SearchParams> }) {
  if (!state.laneFeatures.includes("chat_read")) return <EmptyState title="Chats are not enabled" description="Chats are not turned on for this company's Teams." />;
  if (state.missing.includes("chat_read")) return null; // the feature-missing note above carries the Reconnect button
  return <MessagesWorkspace laneId={laneId} state={state} searchParams={searchParams} />;
}

/** The page below the header, for a given state (the tests render this directly). */
export function MessagesScreen({ laneId, state, workspace = null, chatOpen = false }: { laneId: string; state: MessagesState; /** A chat is open: on a phone the conversation gets the screen, so the "Connected as" card is hidden there (wide screens keep it). */ chatOpen?: boolean; /** The connected person's chats (streamed sections); null where there are none to draw. */ workspace?: ReactNode }) {
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
          <Card className={chatOpen ? "hidden lg:block" : undefined}>
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
          {workspace}
        </div>
      );
  }
}
