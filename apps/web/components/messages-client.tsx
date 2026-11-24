"use client";
// Messages: the few things that need the browser (T-283, T-284, T-290). Each acts only on the person's own click, once when a chat is opened, or (T-290) when the PORTAL'S OWN database says a
// Microsoft notification arrived (components/messages-live.tsx: that loop asks our database, never Microsoft: Microsoft's terms allow no polling loop). There is NO timer in this file.
// Nothing from a chat is stored in the browser (no localStorage, no cookie, no URL): messages live in component state for as long as the page is open. Every request is to this portal's
// own routes (lib/teams-api.ts); the browser never calls Microsoft.
//   MessagesRefresh   re-reads the page (a server refresh) on click; in `live` mode asks the live provider to read again (at most once a minute)
//   ConversationMessages  the conversation's messages, scrolled to the newest, with "Load older messages" (one more page per click)
//   CallButtons       Call and Video call (ask the server for the link, then open it in a new tab) and Open in Teams
//   MarkRead          once per opened chat: records the portal's own read marker
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { Button, buttonVariants, cn } from "@nichols/ui";
import { NEWER_EPOCH } from "@/lib/messages-live-config";
import type { CallState, MessageView } from "@/lib/teams-chats";
import { callUnavailableText, MESSAGES_NO_OLDER_TEXT, MESSAGES_REFRESH_FAILED_TEXT, messagesBusyText, messagesRefreshWaitText } from "@/lib/teams-wording";
import { useMessagesLive, useOnLiveRefetch } from "./messages-live";
import { MessageList } from "./messages-view";
import { PendingBubbles } from "./messages-send";

const JSON_HEADERS = { "content-type": "application/json" } as const;

type Failure = { text: string };
async function failureText(res: Response): Promise<string> {
  const b = (await res.json().catch(() => null)) as { error?: unknown; seconds?: unknown; reason?: unknown } | null;
  if (b?.error === "not_allowed" && b?.reason === "unresolved") return "Someone in this chat no longer has an account. Open the chat in Teams.";
  if (res.status === 429 || b?.error === "busy") return messagesBusyText(typeof b?.seconds === "number" ? b.seconds : null);
  if (b?.error === "reconnect") return "Your Teams sign-in expired. Reconnect Teams in Settings.";
  if (b?.error === "feature_missing") return "Reconnect Teams to add call buttons.";
  if (b?.error === "not_allowed") return "A call link is not available for this chat. Use Open in Teams.";
  return "Teams could not be reached. Try again.";
}

/**
 * Refresh. `page` (default): a server refresh of the whole page, as before (the "Try again" of a failed read). `live` (T-290): asks the live provider to read the chat list and the open
 * conversation again; allowed at most once a minute, otherwise it says when ("Already up to date...") and reads nothing.
 */
export function MessagesRefresh({ label = "Refresh", mode = "page" }: { label?: string; mode?: "page" | "live" }) {
  const router = useRouter();
  const live = useMessagesLive();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const click = () => {
    if (pending) return; // a refresh is under way: a second press waits (the button is not disabled: a disabled button would lose the keyboard focus)
    if (mode === "live" && live) {
      const r = live.requestRefresh("refresh");
      setNote(r.ok ? null : messagesRefreshWaitText(r.waitSeconds));
      return;
    }
    start(() => router.refresh());
  };
  return (
    <>
      {/* T-297: `aria-disabled`, not `disabled`: the keyboard focus stays on Refresh while it works and after it. 44 px high on a phone. */}
      <Button type="button" variant="outline" size="sm" aria-disabled={pending ? true : undefined} onClick={click} data-testid="messages-refresh" className="max-lg:min-h-11">
        {label}
      </Button>
      {/* always mounted, so a change is announced: "Refreshing..." while a refresh works, and (live mode) the wait note, visible to everyone */}
      <span role="status" aria-live="polite" data-testid="messages-refresh-note" className="text-small text-muted-foreground">
        {pending ? "Refreshing..." : note}
      </span>
    </>
  );
}

/** `conn` (T-295): the connection (account) the conversation is read as; every request of the open conversation names it, and the server checks it again each time. */
export function ConversationMessages({ laneId, chatKey, conn, initial, nextBefore, group }: { laneId: string; chatKey: string; conn: string; initial: MessageView[]; nextBefore: string | null; group: boolean }) {
  const router = useRouter();
  // Older pages the person asked for. After a Refresh the server sends a new `initial`; the pages kept here are merged BY MESSAGE ID and the "older than" time is the oldest message shown, so no
  // hole can appear between what was loaded before and what the refresh returned (C2).
  const [older, setOlder] = useState<MessageView[]>([]);
  // What the live re-read brought (T-290): messages created or changed after the newest one shown (a lastModifiedDateTime date range), merged by id (an edit replaces, a deletion shows as deleted).
  const [fresh, setFresh] = useState<MessageView[]>([]);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const [state, setState] = useState<{ busy: boolean; error: Failure | null }>({ busy: false, error: null });
  const box = useRef<HTMLDivElement>(null);
  const keep = useRef<{ height: number; top: number } | null>(null);
  const stick = useRef(false);
  const seen = new Set(initial.map((m) => m.id));
  const kept = older.filter((m) => !seen.has(m.id));
  const byId = new Map<string, MessageView>();
  // two copies of one message (the server's page, a live re-read, an older page): the one with the later lastModifiedDateTime wins; with no time on either, the later source wins
  for (const m of [...kept, ...initial, ...fresh]) {
    const have = byId.get(m.id);
    if (!have || (m.modifiedAt ?? "") >= (have.modifiedAt ?? "")) byId.set(m.id, m);
  }
  const all = [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const oldestShown = all.length > 0 ? all[0]?.at ?? null : null;
  const newestShown = all.length > 0 ? all[all.length - 1]?.at ?? null : null;
  // More to load: nothing once an older page said "start of the chat"; else the oldest message shown when older pages are kept, else the server's own time for its page.
  const before = noMore ? null : kept.length > 0 ? oldestShown : nextBefore;
  const latest = useRef({ newestShown });
  useEffect(() => {
    latest.current = { newestShown };
  });

  // A notice arrived (or Refresh was pressed): read what changed in THIS chat since the newest message shown, with a date range; keep what is shown if it fails.
  useOnLiveRefetch((reason, conns) => {
    // a notice of OTHER accounts says nothing about this conversation: it is read again only when its own account is one of those that moved (Refresh and the window coming back read it too)
    if (reason === "notice" && conns !== null && !conns.includes(conn)) return undefined;
    const ac = new AbortController();
    void (async () => {
      try {
        const since = latest.current.newestShown ?? NEWER_EPOCH;
        const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/newer?conn=${encodeURIComponent(conn)}&chat=${encodeURIComponent(chatKey)}&since=${encodeURIComponent(since)}`, { credentials: "same-origin", cache: "no-store", signal: ac.signal });
        if (!res.ok) {
          setRefreshFailed(true);
          return;
        }
        const b = (await res.json()) as { messages?: MessageView[]; truncated?: boolean };
        if (!Array.isArray(b.messages)) throw new Error("shape");
        if (b.truncated === true) {
          // the page was full (or had a next link): changes may be missing from it, and merging it would leave a hole that never closes. The conversation is read again from the server instead.
          setRefreshFailed(false);
          router.refresh();
          return;
        }
        const el = box.current;
        stick.current = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 96 : false; // only follow the newest message when the person is already at the bottom
        setRefreshFailed(false);
        if (b.messages.length === 0) return;
        const incoming = b.messages;
        setFresh((prev) => {
          const m = new Map(prev.map((x) => [x.id, x]));
          for (const x of incoming) m.set(x.id, x);
          return [...m.values()];
        });
        // what the person now sees is read: the portal's own marker moves (never anything at Microsoft)
        const newest = incoming.reduce<string | null>((a, x) => (a === null || x.at > a ? x.at : a), null);
        if (newest !== null) void fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/read`, { method: "POST", headers: JSON_HEADERS, credentials: "same-origin", cache: "no-store", body: JSON.stringify({ conn, chat: chatKey, readThrough: newest }) }).catch(() => undefined);
      } catch {
        if (!ac.signal.aborted) setRefreshFailed(true);
      }
    })();
    return () => ac.abort();
  });
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    stick.current = false;
  }, [fresh]);

  // The newest message is what a person opens a chat for: start at the bottom.
  useLayoutEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatKey]);
  // After older messages are added above, keep what the person was reading where it was.
  useLayoutEffect(() => {
    const el = box.current;
    const k = keep.current;
    if (el && k) el.scrollTop = k.top + (el.scrollHeight - k.height);
    keep.current = null;
  }, [older]);

  async function loadOlder() {
    if (before === null || state.busy) return;
    setState({ busy: true, error: null });
    try {
      const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/older?conn=${encodeURIComponent(conn)}&chat=${encodeURIComponent(chatKey)}&before=${encodeURIComponent(before)}`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        setState({ busy: false, error: { text: await failureText(res) } });
        return;
      }
      const b = (await res.json()) as { messages: MessageView[]; nextBefore: string | null };
      const el = box.current;
      keep.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
      setOlder((o) => [...b.messages, ...o]);
      setNoMore(b.nextBefore === null);
      setState({ busy: false, error: null });
    } catch {
      setState({ busy: false, error: { text: "Teams could not be reached. Try again." } });
    }
  }

  return (
    <div ref={box} data-testid="conversation-scroll" tabIndex={0} role="log" aria-label="Messages in this chat" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4">
      <div className="flex flex-col items-center gap-1">
        {before !== null ? (
          <Button type="button" variant="outline" size="sm" disabled={state.busy} onClick={() => void loadOlder()} data-testid="load-older">
            {state.busy ? "Loading..." : "Load older messages"}
          </Button>
        ) : (
          <p className="text-small text-muted-foreground">{MESSAGES_NO_OLDER_TEXT}</p>
        )}
        {state.error ? (
          <p role="alert" data-testid="older-error" className="text-small text-alert-foreground">
            {state.error.text}
          </p>
        ) : null}
        {refreshFailed ? (
          <p role="alert" data-testid="refresh-failed" className="text-small text-alert-foreground">
            {MESSAGES_REFRESH_FAILED_TEXT}
          </p>
        ) : null}
      </div>
      <ul className="flex flex-col gap-3" data-testid="message-list">
        <MessageList messages={all} group={group} />
        <PendingBubbles shown={all} />
      </ul>
    </div>
  );
}

/**
 * The header's actions (T-297): Call, Video call, Open in Teams and whatever the header passes as `children` (Refresh), then the lines that belong under the header: a call error, the fallback link
 * and, only when calls are unavailable for this chat, the small muted note. The root is `display: contents`, so these are items of the HEADER's own flex row (the actions sit on the right; the lines
 * take a row of their own under it). Each action is 44 px high on a phone.
 */
export function CallButtons({ laneId, chatKey, conn, call, openUrl, children }: { laneId: string; chatKey: string; conn: string; call: CallState; openUrl: string; children?: ReactNode }) {
  const [state, setState] = useState<{ busy: "call" | "video" | null; error: string | null; link: string | null }>({ busy: null, error: null, link: null });
  const note = call === "available" ? null : callUnavailableText(call);

  async function press(video: boolean) {
    if (state.busy) return;
    setState({ busy: video ? "video" : "call", error: null, link: null });
    try {
      const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/call-link`, { method: "POST", headers: JSON_HEADERS, credentials: "same-origin", cache: "no-store", body: JSON.stringify({ conn, chat: chatKey, video }) });
      if (!res.ok) {
        setState({ busy: null, error: await failureText(res), link: null });
        return;
      }
      const b = (await res.json()) as { url?: unknown };
      // The server built it from validated values; this is only a last look before the browser is asked to open it: https on Teams, nothing else.
      const url = typeof b.url === "string" && b.url.startsWith("https://teams.microsoft.com/l/call/0/0?users=") ? b.url : null;
      if (url === null) {
        setState({ busy: null, error: "A call link is not available for this chat. Use Open in Teams.", link: null });
        return;
      }
      // The click is the person's action; Teams itself asks before it calls. If the browser blocks the new tab, the link is shown to click.
      // (`noopener` in the feature string would make window.open return null even when the tab opened, so the opener is cut afterwards instead; the fallback link shows only when the browser really refused.)
      const w = window.open(url, "_blank");
      if (w !== null) {
        try {
          w.opener = null; // cut the new page's reach back to this one; a browser that hands back a cross-origin window may refuse, which is not a failed call
        } catch {
          /* the tab did open */
        }
      }
      setState({ busy: null, error: null, link: w === null ? url : null });
    } catch {
      setState({ busy: null, error: "Teams could not be reached. Try again.", link: null });
    }
  }

  return (
    <div className="contents" data-testid="call-buttons">
      {call === "available" ? (
        <>
          <Button type="button" variant="outline" size="sm" disabled={state.busy !== null} onClick={() => void press(false)} data-testid="call-button" className="max-lg:min-h-11">
            {state.busy === "call" ? "Opening..." : "Call"}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={state.busy !== null} onClick={() => void press(true)} data-testid="video-button" className="max-lg:min-h-11">
            {state.busy === "video" ? "Opening..." : "Video call"}
          </Button>
        </>
      ) : null}
      <a href={openUrl} target="_blank" rel="noopener noreferrer" data-testid="open-in-teams" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "max-lg:min-h-11 max-lg:items-center")}>
        Open in Teams
      </a>
      {children}
      {state.link ? (
        <a href={state.link} target="_blank" rel="noopener noreferrer" data-testid="call-link" className="basis-full text-small font-medium text-primary underline underline-offset-2">
          Open the call in Teams
        </a>
      ) : null}
      {state.error ? (
        <p role="alert" data-testid="call-error" className="basis-full text-small text-alert-foreground">
          {state.error}
        </p>
      ) : null}
      {note ? (
        <p data-testid="call-note" className="basis-full text-small text-muted-foreground">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** Opening a chat records that the newest message shown has been seen (the portal's own marker). No UI: a failure only means the dot may come back. */
export function MarkRead({ laneId, chatKey, conn, readThrough }: { laneId: string; chatKey: string; conn: string; readThrough: string | null }) {
  useEffect(() => {
    if (readThrough === null) return;
    void fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/read`, { method: "POST", headers: JSON_HEADERS, credentials: "same-origin", cache: "no-store", body: JSON.stringify({ conn, chat: chatKey, readThrough }) }).catch(() => undefined);
  }, [laneId, chatKey, conn, readThrough]);
  return null;
}


/** Moves the keyboard focus to the conversation's heading when a chat is opened (C7f), so a screen reader announces the chat and a keyboard user starts inside it. */
export function FocusConversation({ chatKey }: { chatKey: string }) {
  useEffect(() => {
    document.getElementById("conversation-title")?.focus();
  }, [chatKey]);
  return null;
}
