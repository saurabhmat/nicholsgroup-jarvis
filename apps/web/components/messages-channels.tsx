// Messages: the Channels tab (T-291; spec 8.2, 11, 14; T-276 rules). Server sections, streamed behind `SectionBoundary`; nothing here runs on a link prefetch (it renders only after the gate and the
// connect state). The address holds the selection: `?tab=channels&team=<id>&channel=<key>&post=<id>&more=<cursor>`; selecting is a link.
//   - `ChannelsWorkspace` starts the team list, the open team's channels, the open channel's posts and the open post's replies TOGETHER (one request each, different Microsoft resources, no retry),
//     and hands each promise to its own section. A plain chat view never gets here: Microsoft is not asked about teams or channels unless this tab is open.
//   - Teams show the channels of the OPEN team beneath them (one team's channels per click, not every team's); a shared channel is listed and opens in Teams (not read here);
//   - posts come as Graph orders them (the thread with the newest activity first), a page at a time by the person's click ("More posts"); replies of one post by its "Replies" link;
//   - there is NO unread marker and no "new" dot: Microsoft offers no read state for channels; nothing is stored.
// Desktop: teams/channels beside the posts. Phone: the list, then the posts full screen with a back link (never both; no horizontal scroll).
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle, buttonVariants, cn, EmptyState, laneHref } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { accountNeedsAdminConsent, channelAccountsOf, channelsAvailability, openChannelAccountOf } from "@/lib/teams-messages";
import { channelsHref, decodeChannelKey, isMessageId, isTeamId } from "@/lib/teams-channel-key";
import { gateChannel, loadChannels, loadReplies, loadTeams, loadThread, type ChannelListView, type ChannelRowView, type PostView, type RepliesView, type TeamListView, type ThreadView } from "@/lib/teams-channels";
import type { TeamsFailure } from "@/lib/teams-errors";
import type { MessagesAccount, MessagesState } from "@/lib/teams-messages";
import {
  CHANNELS_APPROVAL_TEXT,
  CHANNELS_APPROVAL_TITLE,
  CHANNELS_FORBIDDEN_TEXT,
  CHANNELS_LIST_FORBIDDEN_TEXT,
  CHANNELS_POSTS_ORDER_TEXT,
  CHANNELS_SHARED_OPEN_TEXT,
  MESSAGES_NOT_ENABLED_TEXT,
  CHANNELS_LOAD_ERROR_TEXT,
  CHANNELS_MORE_TEAMS_TEXT,
  CHANNELS_NO_CHANNEL_SELECTED_TEXT,
  CHANNELS_NO_CHANNELS_TEXT,
  CHANNELS_NO_POSTS_TEXT,
  CHANNELS_NO_REPLIES_TEXT,
  CHANNELS_NO_TEAM_SELECTED_TEXT,
  CHANNELS_NO_TEAMS_TEXT,
  CHANNELS_NOT_FOUND_TEXT,
  CHANNELS_PICK_ACCOUNT_TEXT,
  channelsGroupLabel,
  messagesAccountFeatureText,
  messagesReconnectAccountLabel,
  CHANNELS_NOT_ON_TEXT,
  CHANNELS_REPLIES_ERROR_TEXT,
  CHANNELS_REPLIES_MORE_TEXT,
  CHANNELS_SHARED_TEXT,
  MESSAGES_LOAD_ERROR_TITLE,
  MESSAGES_RECONNECT_TITLE,
  messagesBusyText,
  reconnectToAddText,
  TEAMS_ADMIN_CONSENT_TEXT,
} from "@/lib/teams-wording";
import { FocusConversation, MessagesRefresh } from "./messages-client";
import { ComposerSlot, ConversationSkeleton, ChatListSkeleton, WorkspaceLayout } from "./messages-chats";
import { AccountBadge, MessageItem, SignIn } from "./messages-view";
import { SectionBoundary } from "./section-boundary";

type Connected = Extract<MessagesState, { kind: "connected" }>;
type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const CURSOR = /^[A-Za-z0-9_-]{1,3200}$/;
const LINK = "font-medium text-primary underline underline-offset-2";

/** The Channels tab when channels cannot be read yet: not switched on for the company, or this connection has to be reconnected (and, always for this feature, approved by the administrator). */
export function ChannelsUnavailable({ laneId, state }: { laneId: string; state: Connected }) {
  const a = channelsAvailability(state);
  if (a.kind === "off") {
    return (
      <div className="flex flex-col items-start gap-3">
        <EmptyState title="Channels" description={CHANNELS_NOT_ON_TEXT} />
        <Link href={laneHref(laneId, "messages")} className={LINK} data-testid="back-to-chats-link">
          Back to chats
        </Link>
      </div>
    );
  }
  if (a.kind === "ready") return null;
  return (
    <Alert data-testid="channels-reconnect">
      <AlertTitle>Reconnect Teams to add channels</AlertTitle>
      <AlertDescription>
        {reconnectToAddText(["channels_read"])}
        {a.adminConsent ? ` ${TEAMS_ADMIN_CONSENT_TEXT}` : ""}
      </AlertDescription>
      <div className="flex flex-wrap gap-2 pt-2">
        {a.accounts.length > 1 ? (
          a.accounts.map((x) => <SignIn key={x.connectionId} laneId={laneId} connectionId={x.connectionId} label={messagesReconnectAccountLabel(x.label)} />)
        ) : (
          <SignIn laneId={laneId} connectionId={a.accounts[0]?.connectionId ?? state.connectionId} label="Reconnect Teams" />
        )}
      </div>
    </Alert>
  );
}

/**
 * T-296: with channels working on some accounts, an account that cannot read them is said plainly, for that account only, with its own Reconnect (the other accounts' teams are still listed).
 * Several accounts only; with one the tab's own state says it.
 */
export function ChannelAccountNotes({ laneId, state }: { laneId: string; state: Connected }) {
  const lacking = state.accounts.filter((a) => a.usable && !a.has.includes("channels_read"));
  if (lacking.length === 0 || channelAccountsOf(state).length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="channel-account-notes">
      {lacking.map((a) => (
        <Alert key={a.connectionId} data-testid="channel-account-note">
          <AlertDescription>{messagesAccountFeatureText(a.label, `${reconnectToAddText(["channels_read"])}${accountNeedsAdminConsent(state) ? ` ${TEAMS_ADMIN_CONSENT_TEXT}` : ""}`)}</AlertDescription>
          <div className="pt-2">
            <SignIn laneId={laneId} connectionId={a.connectionId} label={messagesReconnectAccountLabel(a.label)} />
          </div>
        </Alert>
      ))}
    </div>
  );
}

/**
 * A failed read: never an empty list. `scope`: what was being read. A refused TEAM list (403) is the sign that the administrator's approval is missing or was withdrawn (it can also mean the account
 * cannot use channels right now, said in the same fixed text, with Reconnect and Try again); a refused CHANNEL LIST is its own sentence; a refused channel is "not a member"; the portal's own
 * refusal (Teams or the feature is off) is never shown as an approval problem.
 */
export function ChannelFailureCard({ failure, laneId, connectionId, testId, scope }: { failure: TeamsFailure; laneId: string; connectionId: string; testId: string; scope: "teams" | "channels" | "channel" }) {
  if (failure.kind === "reconnect") {
    return (
      <Alert variant="alert" data-testid={testId}>
        <AlertTitle>{MESSAGES_RECONNECT_TITLE}</AlertTitle>
        <AlertDescription>Reconnect Teams to read your channels again.</AlertDescription>
        <div className="pt-2">
          <SignIn laneId={laneId} connectionId={connectionId} label="Reconnect Teams" />
        </div>
      </Alert>
    );
  }
  const approval = failure.kind === "forbidden" && scope === "teams";
  const title = failure.kind === "busy" ? "Teams is busy" : approval ? CHANNELS_APPROVAL_TITLE : failure.kind === "not_enabled" ? "Channels are not available" : failure.kind === "not_found" ? "Channel not found" : MESSAGES_LOAD_ERROR_TITLE;
  const text =
    failure.kind === "busy"
      ? messagesBusyText(failure.seconds)
      : approval
        ? `${CHANNELS_APPROVAL_TEXT} ${TEAMS_ADMIN_CONSENT_TEXT}`
        : failure.kind === "not_enabled"
          ? MESSAGES_NOT_ENABLED_TEXT
          : failure.kind === "not_found"
            ? CHANNELS_NOT_FOUND_TEXT
            : failure.kind === "forbidden"
              ? scope === "channels"
                ? CHANNELS_LIST_FORBIDDEN_TEXT
                : CHANNELS_FORBIDDEN_TEXT
              : CHANNELS_LOAD_ERROR_TEXT;
  return (
    <Alert variant="alert" data-testid={testId} data-failure={failure.kind}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{text}</AlertDescription>
      {failure.kind !== "not_found" && failure.kind !== "not_enabled" ? (
        <div className="flex flex-wrap items-center gap-2 pt-2">
          {approval ? <SignIn laneId={laneId} connectionId={connectionId} label="Reconnect Teams" /> : null}
          <MessagesRefresh label="Try again" />
        </div>
      ) : null}
    </Alert>
  );
}

// ---- teams and their channels
export function ChannelRows({ laneId, teamId, selectedKey, view, connectionId, conn = null }: { laneId: string; teamId: string; selectedKey: string | null; view: ChannelListView; connectionId: string; /** The account named in the address (two or more channel accounts only). */ conn?: string | null }) {
  if (view.kind !== "ok") return <ChannelFailureCard failure={view} laneId={laneId} connectionId={connectionId} testId="channel-list-error" scope="channels" />;
  if (view.channels.length === 0) return <p className="px-4 py-2 text-small text-muted-foreground">{CHANNELS_NO_CHANNELS_TEXT}</p>;
  const base = laneHref(laneId, "messages");
  return (
    <ul className="flex flex-col" data-testid="channel-list">
      {view.channels.map((c: ChannelRowView) =>
        c.readable ? (
          <li key={c.key}>
            <Link
              href={channelsHref(base, { conn, team: teamId, channel: c.key })}
              scroll={false}
              aria-current={c.key === selectedKey ? "page" : undefined}
              data-testid="channel-row"
              className={cn("flex min-h-11 items-center gap-2 py-2 pl-8 pr-4 hover:bg-muted focus-visible:bg-muted", c.key === selectedKey && "bg-muted")}
            >
              <span dir="auto" className="min-w-0 flex-1 truncate text-body">
                <span aria-hidden>#</span> {c.name}
              </span>
              {c.kind === "private" ? <span className="shrink-0 rounded-full border border-border px-2 text-small text-muted-foreground">Private</span> : null}
            </Link>
          </li>
        ) : (
          <li key={c.key} data-testid="channel-row-shared" className="flex min-h-11 flex-wrap items-center gap-x-2 py-2 pl-8 pr-4">
            <span dir="auto" className="min-w-0 truncate text-body">
              <span aria-hidden>#</span> {c.name}
            </span>
            {c.kind === "shared" ? <span className="shrink-0 rounded-full border border-border px-2 text-small text-muted-foreground">Shared</span> : null}
            <a href={c.openUrl} target="_blank" rel="noopener noreferrer" className={cn(LINK, "text-small")}>
              Open in Teams
            </a>
            <span className="sr-only">{CHANNELS_SHARED_TEXT}</span>
          </li>
        ),
      )}
    </ul>
  );
}

async function ChannelRowsSection({ promise, laneId, teamId, selectedKey, connectionId, conn }: { promise: Promise<ChannelListView>; laneId: string; teamId: string; selectedKey: string | null; connectionId: string; conn: string | null }) {
  return <ChannelRows view={await promise} laneId={laneId} teamId={teamId} selectedKey={selectedKey} connectionId={connectionId} conn={conn} />;
}

function ChannelsInline({ promise, laneId, teamId, selectedKey, connectionId, conn }: { promise: Promise<ChannelListView>; laneId: string; teamId: string; selectedKey: string | null; connectionId: string; conn: string | null }) {
  return (
    <SectionBoundary>
      <Suspense fallback={<div role="status" aria-busy="true" data-testid="channel-list-skeleton" className="px-4 py-2 text-small text-muted-foreground">Loading channels</div>}>
        <ChannelRowsSection promise={promise} laneId={laneId} teamId={teamId} selectedKey={selectedKey} connectionId={connectionId} conn={conn} />
      </Suspense>
    </SectionBoundary>
  );
}

export function TeamsList({ view, laneId, connectionId, teamId, channels, selectedKey, conn = null }: { view: TeamListView; laneId: string; connectionId: string; teamId: string | null; channels: Promise<ChannelListView> | null; selectedKey: string | null; /** The account named in the address (two or more channel accounts only): every link of this group carries it. */ conn?: string | null }) {
  if (view.kind !== "ok") return <ChannelFailureCard failure={view} laneId={laneId} connectionId={connectionId} testId="team-list-error" scope="teams" />;
  const base = laneHref(laneId, "messages");
  const known = view.teams.some((t) => t.teamId === teamId);
  if (view.teams.length === 0 && !teamId) return <EmptyState title="No teams" description={CHANNELS_NO_TEAMS_TEXT} />;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ul className="divide-y divide-border rounded-card border border-border bg-card" data-testid="team-list">
        {view.teams.map((t) => (
          <li key={t.teamId}>
            <Link
              href={channelsHref(base, { conn, team: t.teamId })}
              scroll={false}
              aria-current={t.teamId === teamId && selectedKey === null ? "page" : undefined}
              aria-expanded={t.teamId === teamId}
              data-testid="team-row"
              className={cn("flex min-h-14 items-center gap-2 px-4 py-3 hover:bg-muted focus-visible:bg-muted", t.teamId === teamId && "bg-muted")}
            >
              <span aria-hidden className="shrink-0 text-muted-foreground">{t.teamId === teamId ? "▾" : "▸"}</span>
              <span dir="auto" className="min-w-0 flex-1 truncate text-body font-medium">
                {t.name}
              </span>
              {t.archived ? <span className="shrink-0 rounded-full border border-border px-2 text-small text-muted-foreground">Archived</span> : null}
            </Link>
            {t.teamId === teamId && channels ? <ChannelsInline promise={channels} laneId={laneId} teamId={t.teamId} selectedKey={selectedKey} connectionId={connectionId} conn={conn} /> : null}
          </li>
        ))}
      </ul>
      {teamId && channels && !known ? (
        <div className="rounded-card border border-border bg-card">
          <ChannelsInline promise={channels} laneId={laneId} teamId={teamId} selectedKey={selectedKey} connectionId={connectionId} conn={conn} />
        </div>
      ) : null}
      {view.more ? <p className="text-small text-muted-foreground">{CHANNELS_MORE_TEAMS_TEXT}</p> : null}
    </div>
  );
}

async function TeamsSection({ promise, channels, laneId, connectionId, teamId, selectedKey, conn }: { promise: Promise<TeamListView>; channels: Promise<ChannelListView> | null; laneId: string; connectionId: string; teamId: string | null; selectedKey: string | null; conn: string | null }) {
  return <TeamsList view={await promise} laneId={laneId} connectionId={connectionId} teamId={teamId} channels={channels} selectedKey={selectedKey} conn={conn} />;
}

// ---- posts and replies
function Replies({ view }: { view: RepliesView }) {
  if (view.kind !== "ok") {
    return (
      <p role="alert" data-testid="replies-error" className="px-1 text-small text-alert-foreground">
        {CHANNELS_REPLIES_ERROR_TEXT}
      </p>
    );
  }
  return (
    <div className="w-full pl-3 sm:pl-6" data-testid="replies">
      {view.replies.length === 0 ? (
        <p className="text-small text-muted-foreground">{CHANNELS_NO_REPLIES_TEXT}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="reply-list">
          {view.replies.map((r) => (
            <MessageItem key={r.id} m={r} showSender showDate />
          ))}
        </ul>
      )}
      {view.more ? <p className="mt-1 text-small text-muted-foreground">{CHANNELS_REPLIES_MORE_TEXT}</p> : null}
    </div>
  );
}

function PostFooter({ post, open, href, replies }: { post: PostView; open: boolean; href: string; replies: RepliesView | null }) {
  return (
    <div className="flex w-full flex-col gap-1 px-1">
      <p className="flex flex-wrap items-center gap-x-3 text-small">
        <Link href={href} scroll={false} data-testid="replies-link" aria-expanded={open} className={LINK}>
          {open ? "Hide replies" : "Replies"}
        </Link>
        <a href={post.openUrl} target="_blank" rel="noopener noreferrer" data-testid="open-post-in-teams" className={LINK}>
          Open in Teams
        </a>
      </p>
      {open && replies ? <Replies view={replies} /> : null}
    </div>
  );
}

export function ThreadPane({
  thread,
  replies,
  laneId,
  connectionId,
  conn = null,
  account = null,
  teamId,
  channelKey,
  postId,
  more,
  title,
  subtitle,
  openUrl,
}: {
  thread: ThreadView;
  replies: RepliesView | null;
  laneId: string;
  connectionId: string;
  /** The account named in the address (two or more channel accounts only): every link of the pane carries it. */
  conn?: string | null;
  /** The account the posts are read and posted as, shown beside the team name (two or more accounts only). */
  account?: { label: string; name: string } | null;
  teamId: string;
  channelKey: string;
  postId: string | null;
  more: string | null;
  title: string;
  /** The team name (text), or a slot that fills in when the team list arrives: the posts never wait for it. */
  subtitle: ReactNode;
  openUrl: string;
}) {
  const base = laneHref(laneId, "messages");
  const header = (
    <header className="flex flex-col gap-2 border-b border-border px-3 py-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <Link href={channelsHref(base, { conn, team: teamId })} aria-label="Back to channels" data-testid="back-to-channels" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-body font-medium text-primary hover:bg-muted lg:hidden">
          <span aria-hidden>←</span>
        </Link>
        <div className="min-w-0 flex-1">
          <h2 id="conversation-title" tabIndex={-1} dir="auto" data-testid="conversation-title" className="truncate text-h3 font-semibold outline-none">
            {title}
          </h2>
          <p dir="auto" className="flex min-w-0 items-center gap-2 text-small text-muted-foreground">
            <span className="min-w-0 truncate">{subtitle}</span>
            {account ? <AccountBadge label={account.label} name={account.name} /> : null}
          </p>
        </div>
        <MessagesRefresh />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a href={openUrl} target="_blank" rel="noopener noreferrer" data-testid="open-channel-in-teams" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          Open in Teams
        </a>
      </div>
    </header>
  );
  const shell = (body: ReactNode) => (
    <section aria-label="Channel posts" data-testid="conversation" className="flex h-[calc(100dvh-8.5rem)] min-h-[22rem] min-w-0 flex-col overflow-hidden rounded-card border border-border bg-card lg:h-auto lg:min-h-0 lg:flex-1">
      {header}
      <div tabIndex={0} role="region" aria-label="Posts in this channel" data-testid="conversation-scroll" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4">
        {body}
      </div>
      <ComposerSlot />
      <FocusConversation chatKey={channelKey} />
    </section>
  );
  if (thread.kind === "shared") {
    return shell(
      <div data-testid="shared-channel" className="flex flex-col items-start gap-2">
        <p className="text-body">{CHANNELS_SHARED_OPEN_TEXT}</p>
        <a href={thread.openUrl} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: "default", size: "sm" }))}>
          Open in Teams
        </a>
      </div>,
    );
  }
  if (thread.kind !== "ok") return shell(<ChannelFailureCard failure={thread} laneId={laneId} connectionId={connectionId} testId="conversation-error" scope="channel" />);
  const onPage = postId !== null && thread.posts.some((p) => p.id === postId);
  return shell(
    <>
      <p className="text-small text-muted-foreground" data-testid="posts-order">
        {CHANNELS_POSTS_ORDER_TEXT}
      </p>
      {more ? (
        <Link href={channelsHref(base, { conn, team: teamId, channel: channelKey })} scroll={false} data-testid="newest-posts" className={cn(LINK, "text-small")}>
          Back to the newest posts
        </Link>
      ) : null}
      {postId !== null && !onPage && replies ? (
        <div className="rounded-card border border-border p-3" data-testid="replies-elsewhere">
          <p className="mb-2 flex items-center gap-3 text-small">
            <span className="font-medium">Replies</span>
            <Link href={channelsHref(base, { conn, team: teamId, channel: channelKey, more })} scroll={false} className={LINK}>
              Close
            </Link>
          </p>
          <Replies view={replies} />
        </div>
      ) : null}
      {thread.posts.length === 0 ? (
        <p className="text-small text-muted-foreground" data-testid="no-posts">
          {CHANNELS_NO_POSTS_TEXT}
        </p>
      ) : (
        <ul className="flex flex-col gap-4" data-testid="post-list">
          {thread.posts.map((p) => {
            const open = p.id === postId;
            return (
              <MessageItem
                key={p.id}
                m={p}
                showSender
                showDate
                subject={p.subject}
                footer={<PostFooter post={p} open={open} href={channelsHref(base, { conn, team: teamId, channel: channelKey, post: open ? null : p.id, more })} replies={open ? replies : null} />}
              />
            );
          })}
        </ul>
      )}
      {thread.nextCursor ? (
        <Link href={channelsHref(base, { conn, team: teamId, channel: channelKey, more: thread.nextCursor })} scroll={false} data-testid="more-posts" className={cn(LINK, "self-center text-small")}>
          More posts
        </Link>
      ) : null}
    </>,
  );
}

/** The team's name, filled in when the team list arrives: the posts never wait for it. */
async function TeamName({ teams, teamId }: { teams: Promise<TeamListView>; teamId: string }) {
  const v = await teams;
  return <>{v.kind === "ok" ? (v.teams.find((t) => t.teamId === teamId)?.name ?? "") : ""}</>;
}

async function ThreadSection(props: {
  thread: Promise<ThreadView>;
  replies: Promise<RepliesView> | null;
  channels: Promise<ChannelListView>;
  teams: Promise<TeamListView>;
  laneId: string;
  connectionId: string;
  conn: string | null;
  account: { label: string; name: string } | null;
  teamId: string;
  channelKey: string;
  postId: string | null;
  more: string | null;
}) {
  // The posts and replies are read only after the team's channel list has answered (it tells whether the channel may be read at all: a shared channel is not), so `channels` is settled by the time
  // `thread` is. The TEAM list is not waited for: only the subtitle needs it and it fills in on its own.
  const [thread, replies, channels] = await Promise.all([props.thread, props.replies, props.channels]);
  const channel = channels.kind === "ok" ? channels.channels.find((c) => c.key === props.channelKey) : undefined;
  return (
    <ThreadPane
      thread={thread}
      replies={replies}
      laneId={props.laneId}
      connectionId={props.connectionId}
      conn={props.conn}
      account={props.account}
      teamId={props.teamId}
      channelKey={props.channelKey}
      postId={props.postId}
      more={props.more}
      title={channel?.name ?? "Channel"}
      subtitle={
        <Suspense fallback={null}>
          <TeamName teams={props.teams} teamId={props.teamId} />
        </Suspense>
      }
      openUrl={channel?.openUrl ?? "https://teams.microsoft.com"}
    />
  );
}

export function NoChannelSelected({ team }: { team: boolean }) {
  return <EmptyState title={team ? "Select a channel" : "Select a team"} description={team ? CHANNELS_NO_CHANNEL_SELECTED_TEXT : CHANNELS_NO_TEAM_SELECTED_TEXT} />;
}

/**
 * The connected person's channels. Reads the address, then STARTS the team list, the open team's channels, the open channel's posts and the open post's replies together; each streams into its own
 * boundary. Never throws for a Teams failure (the loaders return one); a database or session problem is the section boundary's.
 */
export async function ChannelsWorkspace({ laneId, state, searchParams }: { laneId: string; state: Connected; searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  // T-296 (spec 22.9): one team list per account that can read channels, all started together; the address names the account of the open team (`conn`, re-checked against the person's own usable
  // accounts that have channels: another person's, an unknown, an expired or a feature-less account's id opens nothing and falls back to nothing).
  const accounts = channelAccountsOf(state);
  const grouped = accounts.length >= 2;
  const open: MessagesAccount | undefined = openChannelAccountOf(state, sp);
  const teamRaw = one(sp.team);
  const teamAsked = isTeamId(teamRaw) ? teamRaw : null;
  const teamId = open ? teamAsked : null;
  const channelKey = teamId ? (one(sp.channel) ?? null) : null;
  const channelId = decodeChannelKey(channelKey);
  const postRaw = one(sp.post);
  const postId = channelId !== null && isMessageId(postRaw) ? postRaw : null;
  const moreRaw = one(sp.more);
  const more = channelId !== null && moreRaw !== undefined && CURSOR.test(moreRaw) ? moreRaw : null;
  const { session } = await (await guards()).requireLane(laneId as Parameters<Awaited<ReturnType<typeof guards>>["requireLane"]>[0]);
  const personOf = (a: MessagesAccount) => ({ laneId, userId: session.userId, connectionId: a.connectionId });
  // started together, before any is awaited: every account's team list and the open team's channels. The open channel's posts and the open post's replies start as soon as the channel list has answered,
  // because that list says whether the channel may be read at all (a shared channel is never read); they do not wait for the team lists or each other. Only the open account reads channels, posts and replies.
  const lists = accounts.map((a) => ({ account: a, teams: loadTeams(personOf(a)) }));
  const person = open ? personOf(open) : null;
  const openTeams = lists.find((l) => l.account.connectionId === open?.connectionId)?.teams ?? null;
  const channels = teamId && person ? loadChannels(person, teamId) : null;
  const gate = channels && channelId && channelKey ? channels.then((list) => gateChannel(list, channelKey)) : null;
  const thread = gate && person && teamId && channelId ? gate.then((g): Promise<ThreadView> | ThreadView => (g.ok ? loadThread(person, teamId, channelId, more ? { cursor: more } : {}) : g.view)) : null;
  const replies = gate && person && teamId && channelId && postId ? gate.then((g): Promise<RepliesView> | RepliesView => (g.ok ? loadReplies(person, teamId, channelId, postId) : { kind: "unavailable" })) : null;
  const selectedKey = channelId ? channelKey : null;
  const connOf = (a: MessagesAccount): string | null => (grouped ? a.connectionId : null);
  const section = (l: (typeof lists)[number]) => {
    const isOpen = open !== undefined && l.account.connectionId === open.connectionId;
    return (
      <SectionBoundary>
        <Suspense fallback={<ChatListSkeleton />}>
          <TeamsSection promise={l.teams} channels={isOpen ? channels : null} laneId={laneId} connectionId={l.account.connectionId} teamId={isOpen ? teamId : null} selectedKey={isOpen ? selectedKey : null} conn={connOf(l.account)} />
        </Suspense>
      </SectionBoundary>
    );
  };
  return (
    <div className="flex min-w-0 flex-col gap-4 lg:min-h-0 lg:flex-1">
      <ChannelAccountNotes laneId={laneId} state={state} />
      <WorkspaceLayout
        selected={channelId !== null && open !== undefined}
        list={
          grouped ? (
            <div className="flex flex-col gap-4" data-testid="team-groups">
              {lists.map((l) => (
                <section key={l.account.connectionId} aria-label={channelsGroupLabel(l.account.account)} data-testid="team-group" data-conn={l.account.connectionId} className="flex min-w-0 flex-col gap-2">
                  <h3 className="flex min-w-0 items-center gap-2 text-small font-medium text-muted-foreground">
                    <AccountBadge label={l.account.label} name={l.account.account} />
                    <span className="min-w-0 truncate" dir="auto">
                      {l.account.account}
                    </span>
                  </h3>
                  {section(l)}
                </section>
              ))}
            </div>
          ) : (
            lists[0] ? section(lists[0]) : null
          )
        }
        conversation={
          thread && channels && teamId && channelId && channelKey && open && openTeams ? (
            <SectionBoundary>
              <Suspense fallback={<ConversationSkeleton />}>
                <ThreadSection thread={thread} replies={replies} channels={channels} teams={openTeams} laneId={laneId} connectionId={open.connectionId} conn={connOf(open)} account={grouped ? { label: open.label, name: open.account } : null} teamId={teamId} channelKey={channelKey} postId={postId} more={more} />
              </Suspense>
            </SectionBoundary>
          ) : teamAsked !== null && !open ? (
            // a team is in the address but no account of the person's opens it (several accounts and no `conn`, or a `conn` that is not one of their usable channel accounts): said plainly, nothing is guessed or read
            <p data-testid="pick-account" className="rounded-card border border-border p-4 text-body text-muted-foreground">
              {CHANNELS_PICK_ACCOUNT_TEXT}
            </p>
          ) : (
            <NoChannelSelected team={teamId !== null} />
          )
        }
      />
    </div>
  );
}
