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
import { askActivity, getActivity, postSeen, publishDot } from "@/lib/messages-activity-client";
import { ACTIVITY_POLL_MS, FIRST_ANSWER_BACKOFF_MS, FIRST_ANSWER_FAILURES_BEFORE_BACKOFF, FIRST_ANSWER_FINAL_STATUSES, NOTICE_FRESH_MS, REFETCH_MIN_GAP_MS } from "@/lib/messages-live-config";
import { hrefFor } from "@/lib/messages-href";
import type { AccountNote, ChatRowView } from "@/lib/teams-chats";
import { replaceAccountRows } from "@/lib/teams-row-order";
import { MESSAGES_ACCOUNT_CHANGED_TEXT, MESSAGES_EMPTY_LIST_TEXT, MESSAGES_REFRESH_FAILED_TEXT, messagesAccountBusyText, messagesAccountExpiredText, messagesAccountUnreachableText, messagesReconnectAccountLabel, messagesRefreshWaitText } from "@/lib/teams-wording";
import { Button, EmptyState } from "@nichols/ui";
import { ChatListRows, SignIn } from "./messages-view";
import Link from "next/link";

export type LiveReason = "notice" | "refresh" | "focus";
export type LiveApi = {
  /** Goes up by one each time the page must read Microsoft again. Consumers re-read when it CHANGES after they mounted, never on mount. */
  version: number;
  reason: LiveReason | null;
  /**
   * T-295: for a `notice`, the connections whose latest notice MOVED: only those are read again (their list, and the open conversation only when it is one of them). Null: every account (Refresh, the
   * window coming back, or an older server that answers one aggregate).
   */
  conns: readonly string[] | null;
  /** The last answer from the database said notices work. */
  live: boolean;
  /** A person's action asks for a re-read: allowed at most once per REFETCH_MIN_GAP_MS. */
  requestRefresh(reason: "refresh" | "focus"): { ok: true } | { ok: false; waitSeconds: number };
  /**
   * The chat list was read (on the page's own load or again): the person has seen it (`teams_activity_seen`), for the connections whose list WAS read (T-295: an account whose read failed keeps its
   * dot). Without the names: every usable connection (the one-account page).
   */
  listRefreshed(conns?: readonly string[]): void;
};

const Live = createContext<LiveApi | null>(null);
/** The live context, or null where there is no provider (a failure card, a test). */
export const useMessagesLive = (): LiveApi | null => useContext(Live);

/** Runs `handler` when the provider's version CHANGES after this component mounted (never on mount); the handler may return a cleanup (an abort of its request). */
export function useOnLiveRefetch(handler: (reason: LiveReason, conns: readonly string[] | null) => (() => void) | undefined): void {
  const live = useMessagesLive();
  const last = useRef(live?.version ?? 0);
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler; // declared before the effect below, so it runs first in the same commit
  });
  const version = live?.version ?? 0;
  const reason = live?.reason ?? null;
  const conns = live?.conns ?? null;
  useEffect(() => {
    if (version === last.current) return undefined;
    last.current = version;
    return latest.current(reason ?? "notice", conns);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `conns` belongs to the version that moved it: it is read in the same render, and a new array for the same version must not re-read
  }, [version, reason]);
}

/**
 * `expectLists` (T-295): the page draws a chat list that reports which accounts' lists were read (`listRefreshed(conns)`); the page's own "seen" is then posted for exactly those accounts, once the first
 * answer of the database has come AND the list has reported (in either order). Without it (the default) the first answer marks every usable account seen, as before.
 */
export function MessagesLiveProvider({ laneId, children, expectLists = false }: { laneId: string; children: ReactNode; expectLists?: boolean }) {
  const [state, setState] = useState<{ version: number; reason: LiveReason | null; live: boolean; conns: readonly string[] | null }>({ version: 0, reason: null, live: false, conns: null });
  // `at`: when Microsoft was last read for this page (the page's own load counts as the first read), in the browser's clock; used only for the once-a-minute bound.
  // `notices`: the latest notice time of each connection as the database last said (per account, so only the account that moved is read again); `lastNotice` is the aggregate for an older server.
  const r = useRef({ at: 0, lastNotice: null as string | null, live: false, begun: false, notices: new Map<string, string | null>(), listed: new Set<string>() });
  const bump = useCallback((reason: LiveReason, conns: readonly string[] | null = null) => {
    r.current.at = Date.now();
    setState((s) => ({ ...s, version: s.version + 1, reason, conns }));
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;
    // `begun`: the first answer of the database has come (an answer that failed is not one: the next tick asks again). `off`: the database SAID notices are not working: only that stops the loop.
    let begun = false;
    let off = false;
    let failures = 0; // consecutive failures of the FIRST answer
    let lastTry = 0;
    r.current.at = Date.now();
    const stopLoop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const apply = (live: boolean) => {
      r.current.live = live;
      setState((s) => (s.live === live ? s : { ...s, live }));
    };
    const turnOff = () => {
      off = true;
      apply(false);
      publishDot(laneId, false);
      stopLoop();
    };
    async function poll(): Promise<void> {
      const a = await getActivity(laneId, ac.signal);
      if (a === null || ac.signal.aborted) return; // a failed ask changes nothing; the next tick asks again
      if (!a.live) {
        // notices are not working (or stopped): no dot, no loop; the page offers Refresh
        turnOff();
        return;
      }
      apply(true);
      if (a.accounts.length > 0) {
        // per account: only an account whose latest notice MOVED is read again (T-295)
        const moved = a.accounts.filter((x) => x.lastNoticeAt !== null && x.lastNoticeAt !== (r.current.notices.get(x.conn) ?? null));
        for (const x of a.accounts) r.current.notices.set(x.conn, x.lastNoticeAt);
        r.current.lastNotice = a.lastNoticeAt;
        if (moved.length > 0) bump("notice", moved.map((x) => x.conn)); // ONE re-read per move of an account's last_notice_at
        else publishDot(laneId, a.dot);
        return;
      }
      if (a.lastNoticeAt !== null && a.lastNoticeAt !== r.current.lastNotice) {
        r.current.lastNotice = a.lastNoticeAt;
        bump("notice"); // ONE re-read per move of last_notice_at (an answer without per-account entries: every account)
      } else publishDot(laneId, a.dot);
    }
    async function begin(): Promise<void> {
      lastTry = Date.now();
      const got = await askActivity(laneId, ac.signal);
      if (ac.signal.aborted) return;
      if (!got.ok) {
        // not begun: the next tick or the tab coming back asks again; a refusal that cannot change (not signed in, not allowed, no such route) stops the loop for this page view
        if (got.status !== null && FIRST_ANSWER_FINAL_STATUSES.includes(got.status)) {
          off = true;
          stopLoop();
        } else failures += 1;
        return;
      }
      failures = 0;
      const a = got.answer;
      begun = true;
      r.current.begun = true;
      if (!a.live) {
        turnOff();
        return;
      }
      apply(true);
      r.current.live = true;
      const had = r.current.lastNotice;
      const hadAccounts = new Map(r.current.notices);
      r.current.lastNotice = a.lastNoticeAt;
      for (const x of a.accounts) r.current.notices.set(x.conn, x.lastNoticeAt);
      // A notice that arrived within NOTICE_FRESH_MS of this answer may have come AFTER the server read this page was drawn from (the page streams in; this runs after it): one re-read, counted as a read.
      // Per account (T-295): only the accounts with such a notice are read again.
      const isFresh = (at: string | null) => at !== null && a.serverNow !== null && Date.parse(a.serverNow) - Date.parse(at) <= NOTICE_FRESH_MS;
      if (a.accounts.length > 0) {
        const freshConns = a.accounts.filter((x) => isFresh(x.lastNoticeAt) && x.lastNoticeAt !== (hadAccounts.get(x.conn) ?? null)).map((x) => x.conn);
        if (freshConns.length > 0) {
          bump("notice", freshConns);
          return;
        }
      } else if (isFresh(a.lastNoticeAt) && a.lastNoticeAt !== had) {
        bump("notice");
        return;
      }
      // Opening the chat list is what this page just did: the notices that arrived before it are covered by the read it made.
      if (expectLists) {
        // only the accounts whose list was READ are marked seen; if the list has not reported yet, it posts when it does
        if (r.current.listed.size > 0) {
          const seen = await postSeen(laneId, ac.signal, [...r.current.listed]);
          if (seen) publishDot(laneId, seen.dot);
        }
        return;
      }
      const seen = await postSeen(laneId, ac.signal);
      if (seen) publishDot(laneId, seen.dot);
    }
    /** The loop's retry of the first answer: after a few failures in a row, at most every FIRST_ANSWER_BACKOFF_MS (the tab coming back asks at once). */
    const tryBegin = async (): Promise<void> => {
      if (failures >= FIRST_ANSWER_FAILURES_BEFORE_BACKOFF && Date.now() - lastTry < FIRST_ANSWER_BACKOFF_MS) return;
      await begin();
    };
    const startLoop = () => {
      // The ONLY loop. It asks our own database; it never calls Microsoft. Until the first answer has come (or when it failed) the tick asks for that first answer again.
      if (timer === null && !off && document.visibilityState === "visible") timer = setInterval(() => void (begun ? poll() : tryBegin()), ACTIVITY_POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        stopLoop(); // hidden: nothing is asked while nobody looks
        return;
      }
      if (off) return;
      void (begun ? poll() : begin());
      startLoop();
    };
    const onFocus = () => {
      // coming back to the window: a person's action, bounded to once a minute
      if (Date.now() - r.current.at >= REFETCH_MIN_GAP_MS) bump("focus");
    };
    if (document.visibilityState === "visible") {
      void begin();
      startLoop();
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      ac.abort();
      stopLoop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [laneId, bump, expectLists]);

  const api = useMemo<LiveApi>(
    () => ({
      version: state.version,
      reason: state.reason,
      conns: state.conns,
      live: state.live,
      requestRefresh(reason) {
        const wait = REFETCH_MIN_GAP_MS - (Date.now() - r.current.at);
        if (wait > 0) return { ok: false, waitSeconds: Math.ceil(wait / 1000) };
        bump(reason);
        return { ok: true };
      },
      listRefreshed(conns) {
        for (const c of conns ?? []) r.current.listed.add(c);
        // before the first answer (or while notices are not known to work) nothing is posted: the first answer posts for the accounts reported by then
        if (!r.current.live || !r.current.begun) return;
        void postSeen(laneId, undefined, conns).then((a) => {
          if (a) publishDot(laneId, a.dot);
        });
      },
    }),
    [state, bump, laneId],
  );
  return <Live.Provider value={api}>{children}</Live.Provider>;
}

// ---- the chat list that can read itself again
type ListState = { rows: ChatRowView[]; moreCursor: string | null; notes: AccountNote[]; dropped: boolean; failed: boolean };
type ChatsAnswer = { rows?: ChatRowView[]; moreCursor?: string | null; notes?: AccountNote[]; listed?: string[]; dropped?: boolean };

/** One plain line per account that did not answer (T-295, spec 22.5), with what the person can do about it. */
export function AccountNotes({ laneId, notes, dropped }: { laneId: string; notes: readonly AccountNote[]; dropped: boolean }) {
  if (notes.length === 0 && !dropped) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="account-notes">
      {notes.map((n) => (
        <div key={n.conn} role="alert" data-testid="account-note" data-kind={n.kind} className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-muted px-3 py-2 text-small">
          <span dir="auto" className="min-w-0 [overflow-wrap:anywhere]">
            {n.kind === "reconnect" ? messagesAccountExpiredText(n.label) : n.kind === "busy" ? messagesAccountBusyText(n.label, n.seconds) : messagesAccountUnreachableText(n.label)}
          </span>
          {n.kind === "reconnect" ? <SignIn laneId={laneId} connectionId={n.conn} label={messagesReconnectAccountLabel(n.label)} /> : null}
        </div>
      ))}
      {dropped ? (
        <p role="status" data-testid="account-dropped" className="text-small text-muted-foreground">
          {MESSAGES_ACCOUNT_CHANGED_TEXT}
        </p>
      ) : null}
    </div>
  );
}

const NO_NOTES: AccountNote[] = []; // a stable default: a new array on every render would look like a new page of rows

/**
 * The rows of the chat list, the same as the page drew them, plus a Refresh and the re-read: after a notice or an allowed Refresh the list is fetched again from `/messages/chats` (the same read the
 * page makes), keeping what is shown if it fails. T-295: after a notice of ONE account only that account's list is read again (`?conn=`) and its rows are replaced; Refresh and the window coming back
 * read every account (one request to our server). A failed account is a line, never an empty list.
 */
export function ChatListLive({
  laneId,
  initialRows,
  moreCursor,
  selectedKey,
  more,
  selectedConn = null,
  initialNotes = NO_NOTES,
  initialDropped = false,
  initialListed,
}: {
  laneId: string;
  initialRows: ChatRowView[];
  moreCursor: string | null;
  selectedKey: string | null;
  more: string | null;
  /** The account of the open chat (null: any, with one account). */
  selectedConn?: string | null;
  initialNotes?: AccountNote[];
  initialDropped?: boolean;
  /** The accounts whose list the page read: reported once to the live provider (they are marked seen); undefined for a caller that does not report. */
  initialListed?: string[];
}) {
  const live = useMessagesLive();
  const [state, setState] = useState<ListState>({ rows: initialRows, moreCursor, notes: initialNotes, dropped: initialDropped, failed: false });
  // a new page of rows from the server (a navigation, a server refresh) replaces what was re-read here (state adjusted during render, as React documents for a changed prop)
  const [seed, setSeed] = useState({ initialRows, moreCursor, initialNotes, initialDropped });
  if (seed.initialRows !== initialRows || seed.moreCursor !== moreCursor || seed.initialNotes !== initialNotes || seed.initialDropped !== initialDropped) {
    setSeed({ initialRows, moreCursor, initialNotes, initialDropped });
    setState({ rows: initialRows, moreCursor, notes: initialNotes, dropped: initialDropped, failed: false });
  }
  const [note, setNote] = useState<string | null>(null);
  const latest = useRef({ selectedKey, more, listRefreshed: live?.listRefreshed });
  useEffect(() => {
    latest.current = { selectedKey, more, listRefreshed: live?.listRefreshed };
  });
  // The page drew these lists: tell the live provider which accounts' lists were read, so exactly those are marked seen (an account that failed keeps its dot).
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (initialListed === undefined) return;
    const k = initialListed.join(",");
    if (reported.current === k) return;
    reported.current = k;
    latest.current.listRefreshed?.(initialListed);
  }, [initialListed]);
  useOnLiveRefetch((reason, conns) => {
    const ac = new AbortController();
    // a notice of some accounts: only those are read; anything else (Refresh, focus, an older server): every account in one request
    const targets: (string | null)[] = reason === "notice" && conns !== null && conns.length > 0 ? [...conns] : [null];
    void (async () => {
      const ask = async (conn: string | null): Promise<{ conn: string | null; answer: ChatsAnswer | null }> => {
        try {
          const q = new URLSearchParams();
          if (conn !== null) q.set("conn", conn);
          if (latest.current.selectedKey) q.set("chat", latest.current.selectedKey);
          if (latest.current.more) q.set("more", latest.current.more);
          const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/chats${q.toString() === "" ? "" : `?${q.toString()}`}`, { credentials: "same-origin", cache: "no-store", signal: ac.signal });
          if (!res.ok) return { conn, answer: null };
          const b = (await res.json()) as ChatsAnswer;
          return { conn, answer: Array.isArray(b.rows) ? b : null };
        } catch {
          return { conn, answer: null };
        }
      };
      const answers = await Promise.all(targets.map(ask));
      if (ac.signal.aborted) return;
      let failed = false;
      const listed: string[] = [];
      setState((s) => {
        let next = s;
        for (const { conn, answer } of answers) {
          if (answer === null) {
            failed = true;
            continue;
          }
          const rows = answer.rows as ChatRowView[];
          if (conn === null) {
            next = { rows, moreCursor: typeof answer.moreCursor === "string" ? answer.moreCursor : null, notes: answer.notes ?? [], dropped: answer.dropped === true, failed: false };
            listed.push(...(answer.listed ?? []));
          } else {
            // one account was read again: its rows are replaced, its note is replaced, everything else stays (a cursor of the whole list is not this answer's to change)
            next = { ...next, rows: replaceAccountRows(next.rows, conn, rows), notes: [...next.notes.filter((n) => n.conn !== conn), ...(answer.notes ?? [])], failed: false };
            listed.push(...(answer.listed ?? []));
          }
        }
        return failed ? { ...next, failed: true } : next;
      });
      // an answer that names no accounts (an older server) is a list read for every usable one
      if (answers.some((x) => x.answer !== null)) latest.current.listRefreshed?.(listed.length > 0 ? listed : undefined);
    })();
    return () => ac.abort();
  });
  const refresh = () => {
    if (!live) return;
    const r = live.requestRefresh("refresh");
    setNote(r.ok ? null : messagesRefreshWaitText(r.waitSeconds));
  };
  const hrefOf = (key: string, conn: string | null): string => hrefFor(laneId, key, more, conn);
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
      <AccountNotes laneId={laneId} notes={state.notes} dropped={state.dropped} />
      {state.failed ? (
        <p role="alert" data-testid="chat-list-refresh-failed" className="text-small text-alert-foreground">
          {MESSAGES_REFRESH_FAILED_TEXT}
        </p>
      ) : null}
      {state.rows.length === 0 ? <EmptyState title="No chats" description={MESSAGES_EMPTY_LIST_TEXT} /> : <ChatListRows rows={state.rows} selectedKey={selectedKey} selectedConn={selectedConn} hrefFor={hrefOf} />}
      <div className="flex flex-wrap items-center gap-3 text-small">
        {more ? (
          <Link href={hrefFor(laneId, selectedKey, null, selectedConn)} className="font-medium text-primary underline underline-offset-2" data-testid="newest-chats">
            Back to the newest chats
          </Link>
        ) : null}
        {state.moreCursor ? (
          <Link href={hrefFor(laneId, selectedKey, state.moreCursor, selectedConn)} className="font-medium text-primary underline underline-offset-2" data-testid="more-chats">
            More chats
          </Link>
        ) : null}
      </div>
    </div>
  );
}
