"use client";
// The live Messages page (T-290, spec 9.4): what keeps the chat list and the open conversation current WITHOUT polling Microsoft.
//
// MICROSOFT'S TERMS (vendor facts A3): "If your app polls to see whether a resource has changed, you can only do that once per day"; reading new messages needs a date range. THE LOOP BELOW DOES
// NOT POLL MICROSOFT. It asks the PORTAL'S OWN database (`GET /api/lanes/<lane>/messages/activity`: one row of times, no Graph call) every ACTIVITY_POLL_MS while the tab is visible and
// stops while it is hidden. Microsoft is read again only when (a) that row's `last_notice_at` MOVED, because a notification arrived (a `notice`: at most one re-read per move), or (b) the person
// acted: Refresh, or the window coming back into focus, each at most once per REFETCH_MIN_GAP_MS. Without working notices (no GRAPH_NOTIFICATION_URL, a refused or too-short subscription: the
// route says `live: false`) there is no loop at all and no dot; the page offers Refresh.
//
// Parts: `MessagesLiveProvider` owns the loop and the bounds and hands a `version` down; `ChatListLive` and `ConversationMessages` (messages-client.tsx) re-read on a new `version` only.
// Nothing from a chat is stored in the browser: lists and messages live in component state.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getActivity, postSeen, publishDot } from "@/lib/messages-activity-client";
import { ACTIVITY_POLL_MS, REFETCH_MIN_GAP_MS } from "@/lib/messages-live-config";
import { hrefFor } from "@/lib/messages-href";
import type { ChatRowView } from "@/lib/teams-chats";
import { MESSAGES_EMPTY_LIST_TEXT, MESSAGES_REFRESH_FAILED_TEXT, messagesRefreshWaitText } from "@/lib/teams-wording";
import { Button, EmptyState } from "@nichols/ui";
import { ChatListRows } from "./messages-view";
import Link from "next/link";

export type LiveReason = "notice" | "refresh" | "focus";
export type LiveApi = {
  /** Goes up by one each time the page must read Microsoft again. Consumers re-read when it CHANGES after they mounted, never on mount. */
  version: number;
  reason: LiveReason | null;
  /** The last answer from the database said notices work. */
  live: boolean;
  /** A person's action asks for a re-read: allowed at most once per REFETCH_MIN_GAP_MS. */
  requestRefresh(reason: "refresh" | "focus"): { ok: true } | { ok: false; waitSeconds: number };
  /** The chat list was read again: the person has seen it (`teams_activity_seen`). */
  listRefreshed(): void;
};

const Live = createContext<LiveApi | null>(null);
/** The live context, or null where there is no provider (a failure card, a test). */
export const useMessagesLive = (): LiveApi | null => useContext(Live);

/** Runs `handler` when the provider's version CHANGES after this component mounted (never on mount); the handler may return a cleanup (an abort of its request). */
export function useOnLiveRefetch(handler: (reason: LiveReason) => (() => void) | undefined): void {
  const live = useMessagesLive();
  const last = useRef(live?.version ?? 0);
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler; // declared before the effect below, so it runs first in the same commit
  });
  const version = live?.version ?? 0;
  const reason = live?.reason ?? null;
  useEffect(() => {
    if (version === last.current) return undefined;
    last.current = version;
    return latest.current(reason ?? "notice");
  }, [version, reason]);
}

export function MessagesLiveProvider({ laneId, children }: { laneId: string; children: ReactNode }) {
  const [state, setState] = useState<{ version: number; reason: LiveReason | null; live: boolean }>({ version: 0, reason: null, live: false });
  // `at`: when Microsoft was last read for this page (the page's own load counts as the first read), in the browser's clock; used only for the once-a-minute bound.
  const r = useRef({ at: 0, lastNotice: null as string | null, live: false });
  const bump = useCallback((reason: LiveReason) => {
    r.current.at = Date.now();
    setState((s) => ({ ...s, version: s.version + 1, reason }));
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;
    let started = false;
    r.current.at = Date.now();
    const stopLoop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const apply = (live: boolean) => {
      r.current.live = live;
      setState((s) => (s.live === live ? s : { ...s, live }));
    };
    async function poll(): Promise<void> {
      const a = await getActivity(laneId, ac.signal);
      if (a === null || ac.signal.aborted) return; // a failed ask changes nothing; the next tick asks again
      if (!a.live) {
        // notices are not working (or stopped): no dot, no loop; the page offers Refresh
        apply(false);
        publishDot(laneId, false);
        stopLoop();
        return;
      }
      apply(true);
      if (a.lastNoticeAt !== null && a.lastNoticeAt !== r.current.lastNotice) {
        r.current.lastNotice = a.lastNoticeAt;
        bump("notice"); // ONE re-read per move of last_notice_at
      } else publishDot(laneId, a.dot);
    }
    const startLoop = () => {
      // The ONLY loop. It asks our own database; it never calls Microsoft.
      if (timer === null && r.current.live && document.visibilityState === "visible") timer = setInterval(() => void poll(), ACTIVITY_POLL_MS);
    };
    async function begin(): Promise<void> {
      started = true;
      const a = await getActivity(laneId, ac.signal);
      if (a === null || ac.signal.aborted) return;
      apply(a.live);
      if (!a.live) {
        publishDot(laneId, false);
        return;
      }
      // Opening the chat list is what this page just did: the notices that arrived before it are covered by the read it made.
      r.current.lastNotice = a.lastNoticeAt;
      const seen = await postSeen(laneId, ac.signal);
      if (seen) publishDot(laneId, seen.dot);
      startLoop();
    }
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        stopLoop(); // hidden: nothing is asked while nobody looks
        return;
      }
      if (!started) void begin();
      else if (r.current.live) {
        void poll();
        startLoop();
      }
    };
    const onFocus = () => {
      // coming back to the window: a person's action, bounded to once a minute
      if (Date.now() - r.current.at >= REFETCH_MIN_GAP_MS) bump("focus");
    };
    if (document.visibilityState === "visible") void begin();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      ac.abort();
      stopLoop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [laneId, bump]);

  const api = useMemo<LiveApi>(
    () => ({
      version: state.version,
      reason: state.reason,
      live: state.live,
      requestRefresh(reason) {
        const wait = REFETCH_MIN_GAP_MS - (Date.now() - r.current.at);
        if (wait > 0) return { ok: false, waitSeconds: Math.ceil(wait / 1000) };
        bump(reason);
        return { ok: true };
      },
      listRefreshed() {
        if (!r.current.live) return;
        void postSeen(laneId).then((a) => {
          if (a) publishDot(laneId, a.dot);
        });
      },
    }),
    [state, bump, laneId],
  );
  return <Live.Provider value={api}>{children}</Live.Provider>;
}

// ---- the chat list that can read itself again
type ListState = { rows: ChatRowView[]; moreCursor: string | null; failed: boolean };

/**
 * The rows of the chat list, the same as the page drew them, plus a Refresh and the re-read: after a notice or an allowed Refresh the list is fetched again from `/messages/chats` (the same read the
 * page makes), keeping what is shown if it fails.
 */
export function ChatListLive({ laneId, initialRows, moreCursor, selectedKey, more }: { laneId: string; initialRows: ChatRowView[]; moreCursor: string | null; selectedKey: string | null; more: string | null }) {
  const live = useMessagesLive();
  const [state, setState] = useState<ListState>({ rows: initialRows, moreCursor, failed: false });
  // a new page of rows from the server (a navigation, a server refresh) replaces what was re-read here (state adjusted during render, as React documents for a changed prop)
  const [seed, setSeed] = useState({ initialRows, moreCursor });
  if (seed.initialRows !== initialRows || seed.moreCursor !== moreCursor) {
    setSeed({ initialRows, moreCursor });
    setState({ rows: initialRows, moreCursor, failed: false });
  }
  const [note, setNote] = useState<string | null>(null);
  const latest = useRef({ selectedKey, more, listRefreshed: live?.listRefreshed });
  useEffect(() => {
    latest.current = { selectedKey, more, listRefreshed: live?.listRefreshed };
  });
  useOnLiveRefetch(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const q = new URLSearchParams();
        if (latest.current.selectedKey) q.set("chat", latest.current.selectedKey);
        if (latest.current.more) q.set("more", latest.current.more);
        const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/chats${q.toString() === "" ? "" : `?${q.toString()}`}`, { credentials: "same-origin", cache: "no-store", signal: ac.signal });
        if (!res.ok) {
          setState((s) => ({ ...s, failed: true }));
          return;
        }
        const b = (await res.json()) as { rows?: ChatRowView[]; moreCursor?: string | null };
        if (!Array.isArray(b.rows)) throw new Error("shape");
        setState({ rows: b.rows, moreCursor: typeof b.moreCursor === "string" ? b.moreCursor : null, failed: false });
        latest.current.listRefreshed?.();
      } catch {
        if (!ac.signal.aborted) setState((s) => ({ ...s, failed: true }));
      }
    })();
    return () => ac.abort();
  });
  const refresh = () => {
    if (!live) return;
    const r = live.requestRefresh("refresh");
    setNote(r.ok ? null : messagesRefreshWaitText(r.waitSeconds));
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {live ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={refresh} data-testid="chat-list-refresh">
            Refresh
          </Button>
          <span role="status" aria-live="polite" data-testid="chat-list-refresh-note" className="text-small text-muted-foreground">
            {note}
          </span>
        </div>
      ) : null}
      {state.failed ? (
        <p role="alert" data-testid="chat-list-refresh-failed" className="text-small text-alert-foreground">
          {MESSAGES_REFRESH_FAILED_TEXT}
        </p>
      ) : null}
      {state.rows.length === 0 ? <EmptyState title="No chats" description={MESSAGES_EMPTY_LIST_TEXT} /> : <ChatListRows rows={state.rows} selectedKey={selectedKey} hrefFor={(key) => hrefFor(laneId, key, more)} />}
      <div className="flex flex-wrap items-center gap-3 text-small">
        {more ? (
          <Link href={hrefFor(laneId, selectedKey, null)} className="font-medium text-primary underline underline-offset-2" data-testid="newest-chats">
            Back to the newest chats
          </Link>
        ) : null}
        {state.moreCursor ? (
          <Link href={hrefFor(laneId, selectedKey, state.moreCursor)} className="font-medium text-primary underline underline-offset-2" data-testid="more-chats">
            More chats
          </Link>
        ) : null}
      </div>
    </div>
  );
}
