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
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { askActivity, getActivity, postSeen, publishDot } from "@/lib/messages-activity-client";
import { ACTIVITY_POLL_MS, FIRST_ANSWER_BACKOFF_MS, FIRST_ANSWER_FAILURES_BEFORE_BACKOFF, FIRST_ANSWER_FINAL_STATUSES, NOTICE_FRESH_MS, REFETCH_MIN_GAP_MS } from "@/lib/messages-live-config";
import { hrefFor } from "@/lib/messages-href";
import type { AccountNote, ChatRowView } from "@/lib/teams-chats";
import { replaceAccountRows } from "@/lib/teams-row-order";
import { MESSAGES_ACCOUNT_CHANGED_TEXT, MESSAGES_EMPTY_LIST_TEXT, MESSAGES_REFRESH_FAILED_TEXT, messagesAccountBusyText, messagesAccountExpiredText, messagesAccountUnreachableText, messagesReconnectAccountLabel, messagesRefreshWaitSecondsText, messagesRefreshWaitText } from "@/lib/teams-wording";
import { Button, EmptyState } from "@nichols/ui";
import { ChatListRows, SignIn } from "./messages-view";
import { useMessagesView } from "./messages-scope";

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
  /**
   * A person's action asks for a re-read: allowed at most once per REFETCH_MIN_GAP_MS, EXCEPT while an account's list has not loaded (`setListIncomplete`): then the page is not "up to date" and a Refresh is
   * never held back or told so (the routes' own per-person limiter still bounds it).
   */
  requestRefresh(reason: "refresh" | "focus"): { ok: true } | { ok: false; waitSeconds: number };
  /** The chat list tells the provider whether an account's list is missing (a line "could not be reached / busy / sign-in expired" is showing). */
  setListIncomplete(incomplete: boolean): void;
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
  const r = useRef({ at: 0, lastNotice: null as string | null, live: false, begun: false, incomplete: false, notices: new Map<string, string | null>(), listed: new Set<string>() });
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
      setListIncomplete(incomplete) {
        r.current.incomplete = incomplete;
      },
      requestRefresh(reason) {
        const wait = REFETCH_MIN_GAP_MS - (Date.now() - r.current.at);
        if (!r.current.incomplete && wait > 0) return { ok: false, waitSeconds: Math.ceil(wait / 1000) };
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
/** A line for an account that did not answer; `retryAt` (a busy account: not before this time) is set where the answer is received, never while rendering. */
type TimedNote = AccountNote & { retryAt?: number };
type ListState = { rows: ChatRowView[]; moreCursor: string | null; notes: TimedNote[]; dropped: boolean; failed: boolean };
type ChatsAnswer = { rows?: ChatRowView[]; moreCursor?: string | null; notes?: AccountNote[]; listed?: string[]; dropped?: boolean };

/** One plain line per account that did not answer (T-295, spec 22.5), with what the person can do about it. */
export function AccountNotes({ laneId, notes, dropped, onRetry, retryNote }: { laneId: string; notes: readonly AccountNote[]; dropped: boolean; /** Reads just that account's list again ("Try again"); absent where no list is drawn. */ onRetry?: (note: AccountNote & { retryAt?: number }) => void; /** What a retry said (a "busy" account is not asked before the seconds Microsoft gave), by connection. */ retryNote?: Readonly<Record<string, string>> }) {
  if (notes.length === 0 && !dropped) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="account-notes">
      {notes.map((n) => (
        <div key={n.conn} role="alert" data-testid="account-note" data-kind={n.kind} className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-muted px-3 py-2 text-small">
          <span dir="auto" className="min-w-0 [overflow-wrap:anywhere]">
            {n.kind === "reconnect" ? messagesAccountExpiredText(n.label) : n.kind === "busy" ? messagesAccountBusyText(n.label, n.seconds) : messagesAccountUnreachableText(n.label)}
          </span>
          {n.kind === "reconnect" ? <SignIn laneId={laneId} connectionId={n.conn} label={messagesReconnectAccountLabel(n.label)} /> : null}
          {n.kind !== "reconnect" && onRetry ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onRetry(n)} data-testid="account-note-retry" aria-label={`Try again: ${n.label}`}>
              Try again
            </Button>
          ) : null}
          {retryNote?.[n.conn] ? (
            <span role="status" data-testid="account-note-wait" className="text-muted-foreground">
              {retryNote[n.conn]}
            </span>
          ) : null}
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

/** The part of the list a later page ("More chats") replaces and "Back to the newest chats" brings back: kept in memory only, never stored. */
type Kept = { rows: ChatRowView[]; moreCursor: string | null; notes: TimedNote[]; dropped: boolean };

/**
 * The rows of the chat list, the same as the page drew them, plus a Refresh and the re-read: after a notice or an allowed Refresh the list is fetched again from `/messages/chats` (the same read the
 * page makes), keeping what is shown if it fails. T-295: after a notice of ONE account only that account's list is read again (`?conn=`) and its rows are replaced; Refresh and the window coming back
 * read every account (one request to our server). A failed account is a line, never an empty list.
 *
 * T-296: this list is drawn once by the Messages layout and STAYS MOUNTED while the address changes (`?chat=`, `?conn=`, `?tab=`): a chat click re-reads no list. What the address says (the open chat for
 * the highlight, the tab) comes from `useMessagesView()`; the dot of a chat that was opened is cleared here (the portal's own marker was posted when it was opened); "More chats" reads the next page
 * through the same route and shows it in place of the first (the cursor lives in this component, not in the address, so a page change never re-reads the open conversation). On the Channels tab the
 * list is hidden: a notice then only sets a flag (no read, nothing marked seen) and one read follows when the Chats tab comes back.
 */
export function ChatListLive({
  laneId,
  initialRows,
  moreCursor,
  initialNotes = NO_NOTES,
  initialDropped = false,
  initialListed,
}: {
  laneId: string;
  initialRows: ChatRowView[];
  moreCursor: string | null;
  initialNotes?: AccountNote[];
  initialDropped?: boolean;
  /** The accounts whose list the page read: reported once to the live provider (they are marked seen); undefined for a caller that does not report. */
  initialListed?: string[];
}) {
  const live = useMessagesLive();
  const view = useMessagesView();
  // only a conversation that REALLY opened (the address names a chat that one of the person's accounts opens) is "the open chat": the highlight, the cleared dot and the `chat` / `open` of a re-read
  // follow it, not just a well-formed key in the address (two accounts and no `conn`, or a `conn` that is not theirs, open nothing)
  const selectedKey = view?.open ? view.chatKey : null;
  const selectedConn = view?.open ? view.conn : null;
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  });
  const reloaded = useRef(false);
  const visible = view ? view.tab === "chats" : true;
  const [state, setState] = useState<ListState>({ rows: initialRows, moreCursor, notes: initialNotes, dropped: initialDropped, failed: false });
  // a new page of rows from the server (a server refresh) replaces what was re-read here (state adjusted during render, as React documents for a changed prop)
  const [seed, setSeed] = useState({ initialRows, moreCursor, initialNotes, initialDropped });
  useEffect(() => {
    reloaded.current = false; // a fresh server render re-arms the one reload
  }, [initialRows]);
  // `later`: the cursor of the page shown in place of the newest (null: the newest chats); `kept`: what the newest page looked like, for "Back to the newest chats"
  const [paging, setPaging] = useState<{ later: string | null; kept: Kept | null; busy: boolean }>({ later: null, kept: null, busy: false });
  if (seed.initialRows !== initialRows || seed.moreCursor !== moreCursor || seed.initialNotes !== initialNotes || seed.initialDropped !== initialDropped) {
    setSeed({ initialRows, moreCursor, initialNotes, initialDropped });
    setState({ rows: initialRows, moreCursor, notes: initialNotes, dropped: initialDropped, failed: false });
    setPaging({ later: null, kept: null, busy: false });
  }
  // Chats opened in this page view: their dot is gone at once (opening records the portal's own marker). A re-read of an account's list (it carries the markers) replaces this for that account.
  const [opened, setOpened] = useState<readonly { key: string; conn: string | null }[]>([]);
  if (selectedKey !== null && !opened.some((o) => o.key === selectedKey && o.conn === selectedConn)) setOpened([...opened, { key: selectedKey, conn: selectedConn }]);
  const [note, setNote] = useState<string | null>(null);
  const latest = useRef({ selectedKey, selectedConn, more: paging.later, listRefreshed: live?.listRefreshed, visible });
  useEffect(() => {
    latest.current = { selectedKey, selectedConn, more: paging.later, listRefreshed: live?.listRefreshed, visible };
  });
  // The page drew these lists: tell the live provider which accounts' lists were read, so exactly those are marked seen (an account that failed keeps its dot). A hidden list (the Channels tab) was not seen.
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (initialListed === undefined || !visible) return;
    const k = initialListed.join(",");
    if (reported.current === k) return;
    reported.current = k;
    latest.current.listRefreshed?.(initialListed);
  }, [initialListed, visible]);
  // the Refresh button is never "up to date" while an account's list is missing
  const incomplete = state.notes.length > 0;
  useEffect(() => {
    live?.setListIncomplete(incomplete);
    return () => live?.setListIncomplete(false);
  }, [live, incomplete]);

  /**
   * Reads the lists again: `targets` are accounts (`?conn=`), or `null` for every account in one request. The result (which accounts loaded, whether something failed) is computed here from the
   * answers, OUTSIDE any state updater (React may run an updater later or twice); the updater only applies it.
   */
  const readAgain = useCallback(
    async (targets: (string | null)[], signal: AbortSignal): Promise<void> => {
      let refused = false; // the whole request was refused (not signed in / not allowed / not found), not one account's note
      const ask = async (conn: string | null): Promise<{ conn: string | null; answer: ChatsAnswer | null }> => {
        try {
          const q = new URLSearchParams();
          if (conn !== null) q.set("conn", conn);
          if (latest.current.selectedKey) q.set("chat", latest.current.selectedKey);
          if (latest.current.selectedKey && latest.current.selectedConn) q.set("open", latest.current.selectedConn); // the account of the open chat: its row is the one that is not unread
          if (latest.current.more) q.set("more", latest.current.more);
          const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/chats${q.toString() === "" ? "" : `?${q.toString()}`}`, { credentials: "same-origin", cache: "no-store", signal });
          if (!res.ok) {
            if (res.status === 401 || res.status === 403 || res.status === 404) refused = true;
            // T-288 (carried from the T-296 re-check): a sign-in that expired while its chat is open answers 409 `reconnect` (the `open` account, or `conn`, is no longer usable). The server draws the
            // layout again ONCE (same one-refresh guard as above) so the page shows the account's own Reconnect; the code is the only thing read from the body.
            if (res.status === 409) {
              const code = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
              if (code === "reconnect") refused = true;
            }
            return { conn, answer: null };
          }
          const b = (await res.json()) as ChatsAnswer;
          return { conn, answer: Array.isArray(b.rows) ? b : null };
        } catch {
          return { conn, answer: null };
        }
      };
      const answers = await Promise.all(targets.map(ask));
      if (signal.aborted) return;
      // the server's state moved under this tab (a role revoked, an account disconnected, the module hidden): the layout is drawn again ONCE with what the server says now (guarded: no loop)
      if (refused && !reloaded.current) {
        reloaded.current = true;
        routerRef.current.refresh();
      }
      const failed = answers.some((x) => x.answer === null);
      const listed = answers.flatMap((x) => (x.answer === null ? [] : (x.answer.listed ?? [])));
      const anyOk = answers.some((x) => x.answer !== null);
      setState((s) => {
        let next = s;
        for (const { conn, answer } of answers) {
          if (answer === null) continue;
          const rows = answer.rows as ChatRowView[];
          const received = Date.now();
          const timed: TimedNote[] = (answer.notes ?? []).map((n) => (n.kind === "busy" && n.seconds !== null ? { ...n, retryAt: received + n.seconds * 1000 } : n));
          if (conn === null) {
            next = { rows, moreCursor: typeof answer.moreCursor === "string" ? answer.moreCursor : null, notes: timed, dropped: answer.dropped === true, failed: false };
          } else {
            // one account was read again: its rows are replaced, its note is replaced, everything else stays (a cursor of the whole list is not this answer's to change)
            next = { ...next, rows: replaceAccountRows(next.rows, conn, rows), notes: [...next.notes.filter((n) => n.conn !== conn), ...timed], failed: false };
          }
        }
        return failed ? { ...next, failed: true } : next;
      });
      // the rows just read carry the portal's markers: what was opened before is in them now
      setOpened((o) => o.filter((x) => !answers.some((a) => a.answer !== null && (a.conn === null || a.conn === x.conn || x.conn === null))));
      // an answer that names no accounts (an older server) is a list read for every usable one
      if (anyOk) latest.current.listRefreshed?.(listed.length > 0 ? listed : undefined);
    },
    [laneId],
  );
  // A notice, Refresh or the window coming back while the Channels tab hides this list: nothing is read and nothing is marked seen; one read follows when the Chats tab is back.
  const missed = useRef(false);
  useOnLiveRefetch((reason, conns) => {
    if (!latest.current.visible) {
      missed.current = true;
      return undefined;
    }
    const ac = new AbortController();
    // a notice of some accounts: only those are read; anything else (Refresh, focus, an older server): every account in one request
    const targets: (string | null)[] = reason === "notice" && conns !== null && conns.length > 0 ? [...conns] : [null];
    void readAgain(targets, ac.signal);
    return () => ac.abort();
  });
  useEffect(() => {
    if (!visible || !missed.current) return undefined;
    missed.current = false;
    const ac = new AbortController();
    void readAgain([null], ac.signal);
    return () => ac.abort();
  }, [visible, readAgain]);
  // "Try again" on an account's line: read just that account (counted by the same per-person limit as any re-read). A busy account is not asked before the seconds Microsoft gave.
  const [waits, setWaits] = useState<Record<string, string>>({});
  // when the notes of the server's own page arrived (set after render, in an effect); notes from a re-read carry their own `retryAt`
  const seededAt = useRef(0);
  useEffect(() => {
    seededAt.current = Date.now();
  }, [initialNotes]);
  const retry = (n: TimedNote) => {
    const notBefore = n.retryAt ?? (n.kind === "busy" && n.seconds !== null ? seededAt.current + n.seconds * 1000 : 0);
    const left = Math.ceil((notBefore - Date.now()) / 1000);
    if (left > 0) {
      setWaits((w) => ({ ...w, [n.conn]: messagesRefreshWaitSecondsText(left) }));
      return;
    }
    setWaits((w) => Object.fromEntries(Object.entries(w).filter(([k]) => k !== n.conn)));
    void readAgain([n.conn], new AbortController().signal);
  };
  const refresh = () => {
    if (!live) return;
    const r = live.requestRefresh("refresh");
    setNote(r.ok ? null : messagesRefreshWaitText(r.waitSeconds));
  };

  // "More chats": the next page of every account that has more, through the same route (the cursor is the server's opaque one), shown IN PLACE OF the newest page. A person's click, one request to our server.
  const showMore = async (cursor: string): Promise<void> => {
    if (paging.busy) return;
    setPaging((p) => ({ ...p, busy: true }));
    const keptNow: Kept = paging.kept ?? { rows: state.rows, moreCursor: state.moreCursor, notes: state.notes, dropped: state.dropped };
    try {
      const q = new URLSearchParams({ more: cursor });
      if (selectedKey) q.set("chat", selectedKey);
      if (selectedKey && selectedConn) q.set("open", selectedConn);
      const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/chats?${q.toString()}`, { credentials: "same-origin", cache: "no-store" });
      const b = res.ok ? ((await res.json()) as ChatsAnswer) : null;
      if (b === null || !Array.isArray(b.rows)) throw new Error("shape");
      const received = Date.now();
      const timed: TimedNote[] = (b.notes ?? []).map((n) => (n.kind === "busy" && n.seconds !== null ? { ...n, retryAt: received + n.seconds * 1000 } : n));
      setState({ rows: b.rows, moreCursor: typeof b.moreCursor === "string" ? b.moreCursor : null, notes: timed, dropped: b.dropped === true, failed: false });
      setPaging({ later: cursor, kept: keptNow, busy: false });
    } catch {
      setState((s) => ({ ...s, failed: true }));
      setPaging((p) => ({ ...p, busy: false }));
    }
  };
  const backToNewest = () => {
    const k = paging.kept;
    if (k === null) return;
    setState({ rows: k.rows, moreCursor: k.moreCursor, notes: k.notes, dropped: k.dropped, failed: false });
    setPaging({ later: null, kept: null, busy: false });
  };

  const hrefOf = (key: string, conn: string | null): string => hrefFor(laneId, key, null, conn);
  const rows = state.rows.map((r) => (r.unread && opened.some((o) => o.key === r.key && (o.conn === null || o.conn === r.conn)) ? { ...r, unread: false } : r));
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="chat-list-live">
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
      <AccountNotes laneId={laneId} notes={state.notes} dropped={state.dropped} onRetry={retry} retryNote={waits} />
      {state.failed ? (
        <p role="alert" data-testid="chat-list-refresh-failed" className="text-small text-alert-foreground">
          {MESSAGES_REFRESH_FAILED_TEXT}
        </p>
      ) : null}
      {rows.length === 0 ? <EmptyState title="No chats" description={MESSAGES_EMPTY_LIST_TEXT} /> : <ChatListRows rows={rows} selectedKey={selectedKey} selectedConn={selectedConn} hrefFor={hrefOf} />}
      <div className="flex flex-wrap items-center gap-3 text-small">
        {paging.later !== null ? (
          <Button type="button" variant="outline" size="sm" onClick={backToNewest} data-testid="newest-chats">
            Back to the newest chats
          </Button>
        ) : null}
        {state.moreCursor ? (
          <Button type="button" variant="outline" size="sm" disabled={paging.busy} onClick={() => void showMore(state.moreCursor as string)} data-testid="more-chats">
            {paging.busy ? "Loading..." : "More chats"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
