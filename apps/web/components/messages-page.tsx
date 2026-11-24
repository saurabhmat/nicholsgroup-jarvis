// Messages (T-280, T-283, T-296; spec docs/specs/messages.md 11 "States", 22.6): the connect states of the signed-in person's own Teams account in this company, and, for a connected person, their chat
// list and conversation (components/messages-chats.tsx). No sample data. Every state has a fixed text (rule 9: nothing from the config or the query is rendered), and none shows an empty
// list on an error. T-276: the header is fixed text and the lane check streams in the eyebrow; the connect state is read beside the module gate (`startMessages`); the Graph reads (the chat
// list and the open conversation) start together in the workspace, which renders only after the gate and the connect state, inside Suspense, so a link prefetch makes no Graph request and this
// file reads no clock and imports no Microsoft client.
import Link from "next/link";
import { cache, Suspense, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle, Card, CardDescription, CardHeader, CardTitle, cn, EmptyState, laneHref, PageHeader } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { messagesStateOf, type MessagesState } from "@/lib/teams-messages";
import { teamsSectionFor } from "@/lib/teams-connection";
import { MESSAGES_ACCOUNT_STATE_DEGRADED, MESSAGES_ACCOUNT_STATE_OK, MESSAGES_ACCOUNT_STATE_RECONNECT, MESSAGES_CONNECTED_AS_SEVERAL, messagesAccountFeatureText, messagesReconnectAccountLabel, reconnectToAddText, TEAMS_ADMIN_CONSENT_TEXT, TEAMS_CONNECT_ANOTHER_TEXT, TEAMS_CLOUD_UNSUPPORTED_PAGE_TEXT, TEAMS_CONNECTS_TEXT, TEAMS_NOT_SET_UP_TEXT, TEAMS_PAUSED_PAGE_TEXT } from "@/lib/teams-wording";
import { LaneEyebrow } from "./module-page";
import { ChatListColumn, ConversationSide, ConversationSkeleton } from "./messages-chats";
import { ByTab, LiveTabs, MessagesScope, MessagesTabs, tabOf, type MessagesTab } from "./messages-scope";
import { MessagesLiveProvider } from "./messages-live";
import { ChannelsUnavailable, ChannelsWorkspace } from "./messages-channels";
import { channelsAvailability } from "@/lib/teams-messages";
import { AccountBadge, SignIn } from "./messages-view";
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

/**
 * The Messages LAYOUT's body (app/[laneId]/messages/layout.tsx): the header, the connect states and, for a connected person, the frame that holds the chat list and the page's part (`children`).
 * T-296: a layout is not re-rendered by a change of only `?conn=` / `?chat=` / `?tab=`, so the chat list drawn here is read once and stays mounted across chat clicks. `lg:h-[calc(100dvh-4rem)]`: on a wide
 * window the page is exactly the window's height (the main area's padding is 2rem above and below) and each pane scrolls on its own (T-297).
 */
export function MessagesLayoutShell({ params, children }: { params: Promise<{ laneId: string }>; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-4 lg:h-[calc(100dvh-4rem)]" data-testid="messages-page">
      <PageHeader eyebrow={<LaneEyebrow params={params} />} title="Messages" />
      <Suspense fallback={<CardSkeleton />}>
        <MessagesFrame params={params}>{children}</MessagesFrame>
      </Suspense>
    </div>
  );
}

async function MessagesFrame({ params, children }: { params: Promise<{ laneId: string }>; children: ReactNode }) {
  const laneId = (await params).laneId;
  const state = await messagesState(laneId);
  if (state.kind !== "connected") return <MessagesScreen laneId={laneId} state={state} />;
  return (
    <MessagesScope chatConns={state.accounts.filter((a) => a.usable).map((a) => a.connectionId)} className="flex min-h-0 min-w-0 flex-col lg:flex-1">
      <MessagesScreen laneId={laneId} state={state} liveTabs workspace={<ConnectedFrame laneId={laneId} state={state}>{children}</ConnectedFrame>} />
    </MessagesScope>
  );
}

type Connected = Extract<MessagesState, { kind: "connected" }>;

/** Whether the Chats tab has a list to draw: the company lists chats and at least one usable account has them. */
const chatsListed = (state: Connected): boolean => state.laneFeatures.includes("chat_read") && state.accounts.some((a) => a.usable && a.has.includes("chat_read"));

/**
 * The connected person's frame (T-296): the tabs, the live provider, and the two columns. The left column is the chat list (the layout's own, mounted once); the right column is the page (`children`: the
 * conversation, or the whole Channels workspace, which hides the left column and takes the width). The classes read the `data-view` of the scope (components/messages-scope.tsx), because the layout cannot read the address.
 */
function ConnectedFrame({ laneId, state, children }: { laneId: string; state: Connected; children: ReactNode }) {
  const listed = chatsListed(state);
  const body = (
    <div data-testid="messages-workspace" className="grid min-h-0 min-w-0 gap-4 lg:flex-1 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] group-data-[view=channels]/messages:lg:grid-cols-1 lg:grid-rows-[minmax(0,1fr)]">
      {listed ? (
        <div data-testid="messages-left" className="min-h-0 min-w-0 group-data-[view=channels]/messages:hidden group-data-[view=chat]/messages:max-lg:hidden lg:overflow-y-auto lg:overscroll-contain">
          <ChatListColumn laneId={laneId} state={state} />
        </div>
      ) : null}
      <div data-testid="messages-right" className="min-h-0 min-w-0 group-data-[view=list]/messages:max-lg:hidden">
        {children}
      </div>
    </div>
  );
  return (
    <>
      {state.laneFeatures.includes("channels_read") ? <LiveTabs laneId={laneId} /> : null}
      {listed ? <MessagesLiveProvider laneId={laneId} expectLists>{body}</MessagesLiveProvider> : body}
    </>
  );
}

/** The page's part (app/[laneId]/messages/page.tsx): the conversation side of the Chats tab, or the Channels workspace. The layout drew everything else. */
export function MessagesPage({ params, searchParams }: { params: Promise<{ laneId: string }>; searchParams: Promise<SearchParams> }) {
  return (
    <Suspense fallback={<ConversationSkeleton />}>
      <MessagesBody params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function MessagesBody({ params, searchParams }: { params: Promise<{ laneId: string }>; searchParams: Promise<SearchParams> }) {
  const laneId = (await params).laneId;
  const state = await messagesState(laneId);
  if (state.kind !== "connected") return null; // the layout drew the state's own card
  const tab = tabOf((await searchParams)?.tab);
  return <ConnectedWorkspace laneId={laneId} state={state} tab={tab} searchParams={searchParams} />;
}

export { tabOf, MessagesTabs };
export type { MessagesTab };

/** The page's part for a connected person. Chats need the company's `chat_read` and the connection's: otherwise the page says so (the "Reconnect Teams to add chats" note is the connect card's), never an empty list. */
export function ConnectedWorkspace({ laneId, state, tab, searchParams }: { laneId: string; state: Connected; tab: MessagesTab; searchParams: Promise<SearchParams> }) {
  // T-291: Channels is a second tab. Microsoft is asked about teams and channels only here, only for a company that lists `channels_read` and an account that has it; otherwise a short neutral state.
  if (tab === "channels") {
    return channelsAvailability(state).kind === "ready" ? <ChannelsWorkspace laneId={laneId} state={state} searchParams={searchParams} /> : <ChannelsUnavailable laneId={laneId} state={state} />;
  }
  if (!state.laneFeatures.includes("chat_read")) return <EmptyState title="Chats are not enabled" description="Chats are not turned on for this company's Teams." />;
  // no usable account has chat_read: the feature-missing note above carries the Reconnect button(s)
  if (!state.accounts.some((a) => a.usable && a.has.includes("chat_read"))) return null;
  return <ConversationSide laneId={laneId} state={state} searchParams={searchParams} />;
}

/** The page below the header, for a given state (the tests render this directly). */
export function MessagesScreen({ laneId, state, workspace = null, chatOpen = false, tab = "chats", liveTabs = false }: { laneId: string; state: MessagesState; /** A chat or channel is open: on a phone the conversation gets the screen, so the "Connected as" card is hidden there (wide screens keep it). */ chatOpen?: boolean; /** The open tab: on Channels the feature-missing note leaves out channels (the tab itself says so). */ tab?: MessagesTab; /** T-296: the tab and the open conversation come from the address in the browser (the layout cannot read it): the notes are drawn for both tabs and the scope mounts the right one. */ liveTabs?: boolean; /** The connected person's chats (streamed sections); null where there are none to draw. */ workspace?: ReactNode }) {
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
          <div className="flex flex-wrap gap-2 px-6 pb-6">
            {state.accounts.length > 1 ? (
              state.accounts.map((a) => <SignIn key={a.connectionId} laneId={laneId} connectionId={a.connectionId} label={messagesReconnectAccountLabel(a.label)} />)
            ) : (
              <SignIn laneId={laneId} connectionId={state.connectionId} label="Reconnect Teams" />
            )}
          </div>
        </Card>
      );
    case "connected": {
      const notices = (t: MessagesTab) => <ConnectionNotices laneId={laneId} state={state} tab={t} />;
      return (
        <div className="flex min-h-0 flex-col gap-4 lg:flex-1" data-testid="messages-connected">
          <ConnectionRow laneId={laneId} state={state} className={cn(chatOpen && "hidden lg:flex", "group-data-[open=true]/messages:max-lg:hidden")} />
          {liveTabs ? <ByTab chats={notices("chats")} channels={notices("channels")} /> : notices(tab)}
          {workspace}
        </div>
      );
    }
  }
}

/**
 * T-297: the connection line is ONE slim row (the account, or with several accounts their labels, and the link to Settings), not a card. Connect states that need action keep their full cards
 * (not connected, reconnect, paused, unavailable) and the alerts below it (feature missing, degraded, a problem of one account).
 */
function ConnectionRow({ laneId, state, className }: { laneId: string; state: Connected; className?: string }) {
  const settings = `${laneHref(laneId, "settings")}#connections`;
  const settingsLink = (text: string) => (
    <Link href={settings} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">
      {text}
    </Link>
  );
  return (
    <div data-testid="messages-connection-row" className={cn("flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-card border border-border bg-card px-4 py-1 text-small", className)}>
      {state.accounts.length > 1 ? (
        <>
          <span className="font-medium">Connected accounts</span>
          <ul className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1" data-testid="messages-accounts">
            {state.accounts.map((a) => (
              <li key={a.connectionId} data-testid="messages-account" className="flex min-w-0 items-center gap-2">
                <AccountBadge label={a.label} name={a.account} />
                <span className="min-w-0 [overflow-wrap:anywhere]">{a.account}</span>
                <span className="text-muted-foreground">{!a.usable ? MESSAGES_ACCOUNT_STATE_RECONNECT : a.degraded ? MESSAGES_ACCOUNT_STATE_DEGRADED : MESSAGES_ACCOUNT_STATE_OK}</span>
              </li>
            ))}
          </ul>
          {settingsLink("Manage them in Settings")}
        </>
      ) : (
        <>
          <span className="min-w-0 [overflow-wrap:anywhere]">Connected as {state.account}</span>
          {settingsLink("Manage it in Settings")}
        </>
      )}
      {state.canAddAnother ? (
        <div className="ml-auto" data-testid="messages-connect-another">
          <SignIn laneId={laneId} label={TEAMS_CONNECT_ANOTHER_TEXT} size="sm" />
        </div>
      ) : null}
    </div>
  );
}

/** What is wrong with the connection, said where it needs action, for the open tab: on the Channels tab the note about channels is the tab's own (no second copy); every other missing feature is still listed. */
function ConnectionNotices({ laneId, state, tab }: { laneId: string; state: Connected; tab: MessagesTab }) {
  const missingHere = tab === "channels" ? state.missing.filter((f) => f !== "channels_read") : state.missing;
  return (
    <>
      {state.accounts.length > 1 ? <AccountProblems laneId={laneId} state={state} tab={tab} /> : null}
      {state.accounts.length <= 1 && state.degraded ? (
        <Alert variant="alert" data-testid="messages-degraded">
          <AlertTitle>Teams is having problems</AlertTitle>
          <AlertDescription>The last check of your Teams connection failed. If it keeps happening, reconnect Teams in Settings.</AlertDescription>
        </Alert>
      ) : null}
      {state.accounts.length <= 1 && missingHere.length > 0 ? (
        <Alert data-testid="messages-feature-missing">
          <AlertDescription>
            {reconnectToAddText(missingHere)}
            {state.adminConsent && missingHere.includes("channels_read") ? ` ${TEAMS_ADMIN_CONSENT_TEXT}` : ""}
          </AlertDescription>
          <div className="pt-2">
            <SignIn laneId={laneId} connectionId={state.connectionId} label="Reconnect Teams" />
          </div>
        </Alert>
      ) : null}
    </>
  );
}

/**
 * Several accounts (T-295; spec 22.5 "States"): what is wrong is said for the account it is wrong for ("pub-k.org: Reconnect Teams to add call buttons."), each with its own Reconnect. An expired
 * sign-in is an account line; the list below still shows the other accounts' chats.
 */
function AccountProblems({ laneId, state, tab }: { laneId: string; state: Extract<MessagesState, { kind: "connected" }>; tab: MessagesTab }) {
  const lines = state.accounts.flatMap((a) => {
    const missing = tab === "channels" ? a.missing.filter((f) => f !== "channels_read") : a.missing;
    const out: { key: string; text: string; connectionId: string; label: string }[] = [];
    if (!a.usable) out.push({ key: `${a.connectionId}:expired`, text: `${a.label}: Your Teams sign-in expired.`, connectionId: a.connectionId, label: messagesReconnectAccountLabel(a.label) });
    else if (a.degraded) out.push({ key: `${a.connectionId}:degraded`, text: `${a.label}: Teams is having problems. If it keeps happening, reconnect it.`, connectionId: a.connectionId, label: messagesReconnectAccountLabel(a.label) });
    if (a.usable && missing.length > 0) out.push({ key: `${a.connectionId}:missing`, text: messagesAccountFeatureText(a.label, reconnectToAddText(missing)), connectionId: a.connectionId, label: messagesReconnectAccountLabel(a.label) });
    return out;
  });
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="messages-account-problems">
      {lines.map((l) => (
        <Alert key={l.key} data-testid="messages-account-problem">
          <AlertDescription>{l.text}</AlertDescription>
          <div className="pt-2">
            <SignIn laneId={laneId} connectionId={l.connectionId} label={l.label} />
          </div>
        </Alert>
      ))}
    </div>
  );
}
