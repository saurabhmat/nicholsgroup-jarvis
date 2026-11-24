// Messages: the chat list and the conversation, as streamed sections (T-283, T-284; spec 11; T-276 rules). The page shell, the lane check and the connect state do not wait for Microsoft:
//   - `MessagesWorkspace` starts the chat list read and (when the address names a chat) the conversation read TOGETHER, in the same turn, and hands each promise to its own section;
//   - each section is its own Suspense boundary (a skeleton with the final shape) inside a section error boundary (one section failing never takes the page to the error screen);
//   - nothing here runs on a link prefetch: these are dynamic sections behind the page's gate and its connect state, and the clock is read only after the data has arrived (lib/teams-chats.ts).
// The page address holds the chat (`?chat=<key>`, validated) and, for "More chats", an opaque cursor (`?more=<cursor>`, validated); both are stable targets. Selecting a chat is a link.
// Desktop: list and conversation side by side. Phone: the list, then the conversation full screen with a back link (never both; no horizontal scroll).
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle, cn, EmptyState } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { decodeChatKey } from "@/lib/teams-chat-key";
import { loadChatLists, loadConversation, type ChatListView, type ChatSource, type ConversationView } from "@/lib/teams-chats";
import { looksLikeCursor } from "@/lib/teams-cursor";
import type { TeamsFailure } from "@/lib/teams-errors";
import {
  MESSAGES_CHAT_NOT_FOUND_TEXT,
  MESSAGES_FORBIDDEN_TEXT,
  MESSAGES_LOAD_ERROR_TEXT,
  MESSAGES_LOAD_ERROR_TITLE,
  MESSAGES_NO_CHAT_SELECTED_TEXT,
  MESSAGES_NOT_ENABLED_TEXT,
  MESSAGES_RECONNECT_TITLE,
  MESSAGES_TIMES_NOTE,
  messagesBusyText,
} from "@/lib/teams-wording";
import { openAccountOf, type MessagesState } from "@/lib/teams-messages";
import { hrefFor } from "@/lib/messages-href";
import { CallButtons, ConversationMessages, FocusConversation, MarkRead, MessagesRefresh } from "./messages-client";
import { AccountNotes, ChatListLive, MessagesLiveProvider } from "./messages-live";
import { AccountBadge, SignIn } from "./messages-view";
import { SectionBoundary } from "./section-boundary";

type Connected = Extract<MessagesState, { kind: "connected" }>;
type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);


// ---- skeletons: the final shape (rows of a list, a header and bubbles), so nothing jumps
function Block({ className }: { className?: string }) {
  return <div aria-hidden className={cn("rounded-control bg-muted motion-safe:animate-pulse", className)} />;
}
export function ChatListSkeleton() {
  return (
    <div role="status" aria-busy="true" data-testid="chat-list-skeleton" className="flex min-w-0 flex-col gap-2">
      <span className="sr-only">Loading chats</span>
      {[0, 1, 2, 3, 4].map((i) => (
        <Block key={i} className="h-14 rounded-card" />
      ))}
    </div>
  );
}
export function ConversationSkeleton() {
  return (
    <div role="status" aria-busy="true" data-testid="conversation-skeleton" className="flex min-w-0 flex-col gap-3 rounded-card border border-border p-4">
      <span className="sr-only">Loading messages</span>
      <Block className="h-6 w-56 max-w-full" />
      <Block className="h-12 w-3/4" />
      <Block className="ml-auto h-12 w-2/3" />
      <Block className="h-12 w-4/5" />
    </div>
  );
}

// ---- a failed read: never an empty list
export function TeamsFailureCard({ failure, laneId, connectionId, testId }: { failure: TeamsFailure; laneId: string; connectionId?: string; testId: string }) {
  if (failure.kind === "reconnect") {
    return (
      <Alert variant="alert" data-testid={testId}>
        <AlertTitle>{MESSAGES_RECONNECT_TITLE}</AlertTitle>
        <AlertDescription>Reconnect Teams to read your chats again.</AlertDescription>
        <div className="pt-2">
          <SignIn laneId={laneId} {...(connectionId ? { connectionId } : {})} label="Reconnect Teams" />
        </div>
      </Alert>
    );
  }
  const title = failure.kind === "busy" ? "Teams is busy" : failure.kind === "not_found" ? "Chat not found" : MESSAGES_LOAD_ERROR_TITLE;
  const text = failure.kind === "busy" ? messagesBusyText(failure.seconds) : failure.kind === "not_found" ? MESSAGES_CHAT_NOT_FOUND_TEXT : failure.kind === "forbidden" ? MESSAGES_FORBIDDEN_TEXT : failure.kind === "not_enabled" ? MESSAGES_NOT_ENABLED_TEXT : MESSAGES_LOAD_ERROR_TEXT;
  return (
    <Alert variant="alert" data-testid={testId} data-failure={failure.kind}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{text}</AlertDescription>
      {failure.kind !== "not_found" ? (
        <div className="pt-2">
          <MessagesRefresh label="Try again" />
        </div>
      ) : null}
    </Alert>
  );
}

// ---- the chat list
export function ChatListView({ view, laneId, connectionId, selectedKey, selectedConn = null, more }: { view: ChatListView; laneId: string; connectionId: string; selectedKey: string | null; /** The account of the open chat (several accounts only). */ selectedConn?: string | null; more: string | null }) {
  if (view.kind !== "ok") {
    // every account failed: the existing failure card; with several accounts a plain line per account follows (each with its own Reconnect where that helps)
    const notes = view.notes ?? [];
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <TeamsFailureCard failure={view} laneId={laneId} connectionId={notes.length > 0 ? (notes.find((n) => n.kind === "reconnect")?.conn ?? connectionId) : connectionId} testId="chat-list-error" />
        {notes.length > 1 ? <AccountNotes laneId={laneId} notes={notes} dropped={false} /> : null}
      </div>
    );
  }
  // The rows are drawn by a client component that can read the list again after a notice or a Refresh (T-290); on the server it draws exactly what it always did.
  return (
    <ChatListLive
      laneId={laneId}
      initialRows={view.rows}
      moreCursor={view.moreCursor}
      selectedKey={selectedKey}
      selectedConn={selectedConn}
      more={more}
      initialNotes={view.notes ?? []}
      initialDropped={view.dropped === true}
      {...(view.listed ? { initialListed: view.listed } : {})}
    />
  );
}

async function ChatListSection({ promise, laneId, connectionId, selectedKey, selectedConn, more }: { promise: Promise<ChatListView>; laneId: string; connectionId: string; selectedKey: string | null; selectedConn: string | null; more: string | null }) {
  return <ChatListView view={await promise} laneId={laneId} connectionId={connectionId} selectedKey={selectedKey} selectedConn={selectedConn} more={more} />;
}

// ---- the conversation
export function ConversationPane({ view, laneId, connectionId, more = null }: { view: ConversationView; laneId: string; connectionId: string; more?: string | null }) {
  if (view.kind !== "ok") return <TeamsFailureCard failure={view.kind === "not_found" ? { kind: "not_found" } : view} laneId={laneId} connectionId={connectionId} testId="conversation-error" />;
  return (
    <section aria-label="Conversation" data-testid="conversation" className="flex h-[calc(100dvh-8.5rem)] min-h-[22rem] min-w-0 lg:h-[calc(100dvh-13rem)] lg:min-h-[26rem] flex-col overflow-hidden rounded-card border border-border bg-card">
      <header className="flex flex-col gap-2 border-b border-border px-3 py-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Link href={hrefFor(laneId, null, more)} aria-label="Back to chats" data-testid="back-to-chats" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-body font-medium text-primary hover:bg-muted lg:hidden">
            <span aria-hidden>←</span>
          </Link>
          <div className="min-w-0 flex-1">
            <h2 id="conversation-title" tabIndex={-1} dir="auto" data-testid="conversation-title" className="truncate text-h3 font-semibold outline-none">
              {view.title}
            </h2>
            <p dir="auto" className="flex min-w-0 items-center gap-2 text-small text-muted-foreground">
              <span className="min-w-0 truncate">{view.subtitle}</span>
              {view.account ? <AccountBadge label={view.account} name={view.accountName} /> : null}
            </p>
          </div>
          <MessagesRefresh mode="live" />
        </div>
        <CallButtons laneId={laneId} chatKey={view.chatKey} conn={view.conn} call={view.call} openUrl={view.openUrl} />
      </header>
      <ConversationMessages key={`${view.conn}:${view.chatKey}`} laneId={laneId} chatKey={view.chatKey} conn={view.conn} initial={view.messages} nextBefore={view.nextBefore} group={view.group} />
      <p className="border-t border-border px-4 py-1 text-small text-muted-foreground">{MESSAGES_TIMES_NOTE}</p>
      <FocusConversation chatKey={`${view.conn}:${view.chatKey}`} />
      <MarkRead laneId={laneId} chatKey={view.chatKey} conn={view.conn} readThrough={view.readThrough} />
    </section>
  );
}

async function ConversationSection({ promise, laneId, connectionId, more }: { promise: Promise<ConversationView>; laneId: string; connectionId: string; more: string | null }) {
  return <ConversationPane view={await promise} laneId={laneId} connectionId={connectionId} more={more} />;
}

/** The two panes. `selected` hides the list on a phone (and the empty conversation placeholder is for wide screens only). */
export function WorkspaceLayout({ selected, list, conversation }: { selected: boolean; list: ReactNode; conversation: ReactNode }) {
  return (
    <div data-testid="messages-workspace" data-selected={selected ? "true" : "false"} className="grid min-w-0 gap-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
      <div id="chat-list" data-testid="chat-list-pane" className={cn("min-w-0", selected ? "hidden lg:block" : "block")}>
        {list}
      </div>
      <div id="conversation" data-testid="conversation-pane" className={cn("min-w-0", selected ? "block" : "hidden lg:block")}>
        {conversation}
      </div>
    </div>
  );
}

export function NoChatSelected() {
  return <EmptyState title="Select a chat" description={MESSAGES_NO_CHAT_SELECTED_TEXT} />;
}

/**
 * The connected person's workspace. Reads the address, then STARTS the chat list (one read per usable account with chats, and the person's markers in ONE query) and the conversation together; each
 * streams into its own boundary. Never throws for a Teams failure (the loaders return one); a database or session problem is the section boundary's.
 * T-295: the address names the account of the open chat (`?conn=<id>&chat=<key>`); the page re-checks it against the person's own usable accounts, so an unknown, another person's, a disconnected or an
 * expired account's id opens nothing (the list is still drawn). A `chat` without `conn` opens only for a person with exactly one usable account (old links keep working); with several it is "Select a chat".
 */
export async function MessagesWorkspace({ laneId, state, searchParams }: { laneId: string; state: Connected; searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const chatKey = one(sp.chat) ?? null;
  const chatId = decodeChatKey(chatKey);
  const moreRaw = one(sp.more);
  const more = looksLikeCursor(moreRaw) ? moreRaw : null;
  const openAccount = openAccountOf(state, sp);
  const { session, client } = await (await guards()).requireLane(laneId as Parameters<Awaited<ReturnType<typeof guards>>["requireLane"]>[0]);
  const sources: ChatSource[] = state.accounts.flatMap((a, ord) => (a.usable && a.has.includes("chat_read") ? [{ connectionId: a.connectionId, label: state.multi ? a.label : null, account: a.account, ord }] : []));
  const selectedKey = openAccount && chatId ? chatKey : null;
  const selectedConn = openAccount && state.multi ? openAccount.connectionId : null;
  // started together, before either is awaited
  const list = loadChatLists({ laneId, userId: session.userId, client }, sources, { ...(more ? { cursor: more } : {}), selectedKey, selectedConn });
  const conversation =
    openAccount && chatId && chatKey
      ? loadConversation({ laneId, userId: session.userId, connectionId: openAccount.connectionId, client }, chatId, chatKey, { laneListsCalls: state.laneFeatures.includes("call_links"), connectionHasCalls: openAccount.has.includes("call_links") }, { label: state.multi ? openAccount.label : null, name: openAccount.account })
      : null;
  return (
    <MessagesLiveProvider laneId={laneId} expectLists>
      <WorkspaceLayout
        selected={openAccount !== undefined && chatId !== null}
        list={
          <SectionBoundary>
            <Suspense fallback={<ChatListSkeleton />}>
              <ChatListSection promise={list} laneId={laneId} connectionId={sources[0]?.connectionId ?? state.connectionId} selectedKey={selectedKey} selectedConn={selectedConn} more={more} />
            </Suspense>
          </SectionBoundary>
        }
        conversation={
          conversation && openAccount ? (
            <SectionBoundary>
              <Suspense fallback={<ConversationSkeleton />}>
                <ConversationSection promise={conversation} laneId={laneId} connectionId={openAccount.connectionId} more={more} />
              </Suspense>
            </SectionBoundary>
          ) : (
            <NoChatSelected />
          )
        }
      />
    </MessagesLiveProvider>
  );
}
