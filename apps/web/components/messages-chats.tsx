// Messages: the chat list and the conversation, as streamed sections (T-283, T-284, T-296; spec 11, 22.6; T-276 rules). The page shell, the lane check and the connect state do not wait for Microsoft:
//   - `ChatListColumn` (drawn by the Messages LAYOUT, once) starts the chat list read; `ConversationSide` (the PAGE's part) starts the conversation read when the address names a chat; the two start in
//     the same turn, each into its own Suspense boundary (a skeleton with the final shape) inside a section error boundary (one section failing never takes the page to the error screen);
//   - nothing here runs on a link prefetch: these are dynamic sections behind the page's gate and its connect state, and the clock is read only after the data has arrived (lib/teams-chats.ts).
// The page address holds the open chat (`?conn=<id>&chat=<key>`, validated); selecting a chat is a link, and because the list is the layout's it is NOT read again by a chat click. "More chats" is the
// client list's own request (no `?more=` in the address).
// Desktop: list and conversation side by side. Phone: the list, then the conversation full screen with a back link (never both; no horizontal scroll).
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle, cn, EmptyState } from "@nichols/ui";
import { approvalsDeps } from "@nichols/approvals/wire";
import { WRITE_ROLES } from "@nichols/approvals/server";
import { AuthError } from "@nichols/core/auth";
import { guards } from "@/lib/guards";
import { loadSendView, type SendView } from "@/lib/teams-send-view";
import { decodeChatKey } from "@/lib/teams-chat-key";
import { loadChatLists, loadConversation, type ChatListView, type ChatSource, type ConversationView } from "@/lib/teams-chats";
import type { TeamsFailure } from "@/lib/teams-errors";
import {
  MESSAGES_CHAT_NOT_FOUND_TEXT,
  MESSAGES_FORBIDDEN_TEXT,
  MESSAGES_LOAD_ERROR_TEXT,
  MESSAGES_LOAD_ERROR_TITLE,
  MESSAGES_NO_CHAT_SELECTED_TEXT,
  MESSAGES_PICK_ACCOUNT_TEXT,
  MESSAGES_NOT_ENABLED_TEXT,
  MESSAGES_RECONNECT_TITLE,
  MESSAGES_TIMES_NOTE,
  messagesBusyText,
  SEND_OFF_TEXT,
} from "@/lib/teams-wording";
import { openAccountOf, type MessagesState } from "@/lib/teams-messages";
import { hrefFor } from "@/lib/messages-href";
import { CallButtons, ConversationMessages, FocusConversation, MarkRead, MessagesRefresh } from "./messages-client";
import { Composer, SendScope } from "./messages-send";
import { AccountNotes, ChatListLive } from "./messages-live";
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
export function ChatListView({ view, laneId, connectionId }: { view: ChatListView; laneId: string; connectionId: string }) {
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
      initialNotes={view.notes ?? []}
      initialDropped={view.dropped === true}
      {...(view.listed ? { initialListed: view.listed } : {})}
    />
  );
}

async function ChatListSection({ promise, laneId, connectionId }: { promise: Promise<ChatListView>; laneId: string; connectionId: string }) {
  return <ChatListView view={await promise} laneId={laneId} connectionId={connectionId} />;
}

// ---- the conversation
/**
 * The pinned place at the bottom of the conversation pane (T-297), where the composer goes (T-288). The messages scroll above it; it never scrolls away, and it holds the one line about the time zone.
 * No safe-area padding: the pane is never at the screen edge (on a phone the fixed tab bar below it takes the inset). `children` (the Send box, or the one line that says why there is none) is drawn above that line.
 */
export function ComposerSlot({ children }: { children?: ReactNode }) {
  return (
    <div data-testid="composer-slot" className="group/slot shrink-0 border-t border-border bg-card px-3 py-1 sm:px-4">
      {children}
      {/* on a phone the note gives way while the box has the focus (the keyboard is up and every line counts) */}
      <p data-testid="times-note" className="text-small text-muted-foreground group-has-[[data-focused=true]]/slot:max-lg:hidden">
        {MESSAGES_TIMES_NOTE}
      </p>
    </div>
  );
}

/** The one plain line that says why there is no Send box (T-288), by the gate that is off. A closed gate that Reconnect fixes carries the Reconnect button. */
export function SendOff({ reason, laneId, connectionId }: { reason: keyof typeof SEND_OFF_TEXT; laneId: string; connectionId: string }) {
  return (
    <div data-testid="send-off" data-gate={reason} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1">
      <p className="min-w-0 text-small text-muted-foreground">{SEND_OFF_TEXT[reason]}</p>
      {reason === "reconnect" ? <SignIn laneId={laneId} connectionId={connectionId} label="Reconnect Teams" size="sm" /> : null}
    </div>
  );
}

/** The conversation header (T-297): ONE row: the name and the people line on the left, the actions on the right (they wrap under the name on a phone), and, only when calls are unavailable for this chat, a small muted note under it. */
export function ConversationPane({ view, laneId, connectionId, send = null, userId = "" }: { view: ConversationView; laneId: string; connectionId: string; /** T-288: whether the Send box is offered for this conversation's account, or why not. Null: no Send box and no line (older callers). */ send?: SendView | null; /** Only a key part of the tab's unsent-text copy; never an access decision. */ userId?: string }) {
  if (view.kind !== "ok") return <TeamsFailureCard failure={view.kind === "not_found" ? { kind: "not_found" } : view} laneId={laneId} connectionId={connectionId} testId="conversation-error" />;
  return (
    <section aria-label="Conversation" data-testid="conversation" className="flex h-[var(--pane-h,calc(100dvh-8.5rem))] min-h-[var(--pane-min,16rem)] min-w-0 flex-col overflow-hidden rounded-card border border-border bg-card lg:h-auto lg:min-h-0 lg:flex-1">
      <SendScope key={`${view.conn}:${view.chatKey}`} laneId={laneId} conn={view.conn} chatKey={view.chatKey} userId={userId} enabled={send?.kind === "ready"} clear={send?.kind === "off" && (send.reason === "lane_off" || send.reason === "policy_off" || send.reason === "drafts_off")}>
      <header data-testid="conversation-header" className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2 border-b border-border px-3 py-2 sm:px-4">
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
          <Link href={hrefFor(laneId, null, null)} aria-label="Back to chats" data-testid="back-to-chats" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-body font-medium text-primary hover:bg-muted lg:hidden">
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
        </div>
        <CallButtons laneId={laneId} chatKey={view.chatKey} conn={view.conn} call={view.call} openUrl={view.openUrl}>
          <MessagesRefresh mode="live" />
        </CallButtons>
      </header>
      <ConversationMessages key={`${view.conn}:${view.chatKey}`} laneId={laneId} chatKey={view.chatKey} conn={view.conn} initial={view.messages} nextBefore={view.nextBefore} group={view.group} />
      <ComposerSlot>
        {send === null ? null : send.kind === "ready" ? <Composer key={`${view.conn}:${view.chatKey}`} laneId={laneId} conn={view.conn} chatKey={view.chatKey} account={send.account} accountLabel={view.account} userId={userId} /> : <SendOff reason={send.reason} laneId={laneId} connectionId={view.conn} />}
      </ComposerSlot>
      <FocusConversation chatKey={`${view.conn}:${view.chatKey}`} />
      <MarkRead laneId={laneId} chatKey={view.chatKey} conn={view.conn} readThrough={view.readThrough} />
      </SendScope>
    </section>
  );
}

async function ConversationSection({ promise, sendPromise, laneId, connectionId, userId }: { promise: Promise<ConversationView>; sendPromise: Promise<SendView>; laneId: string; connectionId: string; userId: string }) {
  const [view, send] = await Promise.all([promise, sendPromise]);
  return <ConversationPane view={view} laneId={laneId} connectionId={connectionId} send={view.kind === "ok" ? send : null} userId={userId} />;
}

/** The two panes. `selected` hides the list on a phone (and the empty conversation placeholder is for wide screens only). */
export function WorkspaceLayout({ selected, list, conversation }: { selected: boolean; list: ReactNode; conversation: ReactNode }) {
  return (
    <div data-testid="channels-workspace" data-selected={selected ? "true" : "false"} className="grid min-w-0 gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
      <div id="chat-list" data-testid="chat-list-pane" className={cn("min-w-0 lg:-mx-1.5 lg:-my-1.5 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:px-1.5 lg:py-1.5", selected ? "hidden lg:block" : "block")}>
        {list}
      </div>
      <div id="conversation" data-testid="conversation-pane" className={cn("min-w-0 lg:flex lg:min-h-0 lg:flex-col", selected ? "block" : "hidden lg:block")}>
        {conversation}
      </div>
    </div>
  );
}

export function NoChatSelected() {
  return <EmptyState title="Select a chat" description={MESSAGES_NO_CHAT_SELECTED_TEXT} />;
}

/**
 * The chat list column (T-296). Drawn by the Messages LAYOUT, once: it starts the chat list (one read per usable account with chats, and the person's markers in ONE query) and streams it into its own
 * boundary. It reads nothing from the address (a layout cannot, and must not be re-rendered by a chat click): the open chat, the tab and "More chats" are the client list's own (components/messages-live.tsx).
 * Never throws for a Teams failure (the loaders return one); a database or session problem is the section boundary's.
 */
export async function ChatListColumn({ laneId, state }: { laneId: string; state: Connected }) {
  const { session, client } = await (await guards()).requireLane(laneId as Parameters<Awaited<ReturnType<typeof guards>>["requireLane"]>[0]);
  const sources: ChatSource[] = state.accounts.flatMap((a, ord) => (a.usable && a.has.includes("chat_read") ? [{ connectionId: a.connectionId, label: state.multi ? a.label : null, account: a.account, ord }] : []));
  const list = loadChatLists({ laneId, userId: session.userId, client }, sources, { selectedKey: null, selectedConn: null });
  return (
    <SectionBoundary>
      <Suspense fallback={<ChatListSkeleton />}>
        <ChatListSection promise={list} laneId={laneId} connectionId={sources[0]?.connectionId ?? state.connectionId} />
      </Suspense>
    </SectionBoundary>
  );
}

/**
 * The conversation side of the Chats tab (the page's part; the list is the layout's). Reads the address and, when it names a chat that an account of the person opens, STARTS the conversation read;
 * it streams into its own boundary. Never throws for a Teams failure (the loaders return one).
 * T-295: the address names the account of the open chat (`?conn=<id>&chat=<key>`); the page re-checks it against the person's own usable accounts, so an unknown, another person's, a disconnected or an
 * expired account's id opens nothing (the list is still drawn). A `chat` without `conn` opens only for a person with exactly one usable account (old links keep working); with several it is "Select a chat".
 */
export async function ConversationSide({ laneId, state, searchParams }: { laneId: string; state: Connected; searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const chatKey = one(sp.chat) ?? null;
  const chatId = decodeChatKey(chatKey);
  const openAccount = openAccountOf(state, sp);
  const { session, client } = await (await guards()).requireLane(laneId as Parameters<Awaited<ReturnType<typeof guards>>["requireLane"]>[0]);
  const g = await guards();
  // T-288: whether the Send box is offered for THIS account (database only; starts with the conversation read and does not wait for it)
  const canWrite = async (): Promise<boolean> => {
    try {
      await g.requireRole(laneId as Parameters<typeof g.requireRole>[0], [...WRITE_ROLES["teams.chat.send"]]);
      return true;
    } catch (e) {
      if (e instanceof AuthError) return false;
      throw e;
    }
  };
  const sendView = openAccount && chatId && chatKey ? loadSendView({ readFacts: (l, c) => approvalsDeps.readFacts(l as never, c), canWrite }, laneId, openAccount.connectionId, openAccount.account, session.userId) : null;
  const conversation =
    openAccount && chatId && chatKey
      ? loadConversation({ laneId, userId: session.userId, connectionId: openAccount.connectionId, client }, chatId, chatKey, { laneListsCalls: state.laneFeatures.includes("call_links"), connectionHasCalls: openAccount.has.includes("call_links") }, { label: state.multi ? openAccount.label : null, name: openAccount.account })
      : null;
  if (conversation && openAccount) {
    return (
      <SectionBoundary>
        <Suspense fallback={<ConversationSkeleton />}>
          <ConversationSection promise={conversation} sendPromise={sendView ?? Promise.resolve<SendView>({ kind: "off", reason: "unavailable" })} laneId={laneId} connectionId={openAccount.connectionId} userId={session.userId} />
        </Suspense>
      </SectionBoundary>
    );
  }
  // a chat is in the address but no account of the person opens it (several accounts and no `conn`, or a `conn` that is not one of their usable accounts): said plainly, nothing is guessed or read
  if (chatId !== null)
    return (
      <p data-testid="pick-account" className="rounded-card border border-border p-4 text-body text-muted-foreground">
        {MESSAGES_PICK_ACCOUNT_TEXT}
      </p>
    );
  return <NoChatSelected />;
}
