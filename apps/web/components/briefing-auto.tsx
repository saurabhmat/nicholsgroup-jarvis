"use client";
// The automatic AI summary controls on Home (T-235 part 1), for the OWNER only (the server renders this component only for them):
//   * on mount, ONCE per page load, asks the server to start a background run when the latest briefing is older than 3 hours
//     (ensureFreshBriefing; the SQL claim has the last word: daily cap, one run at a time). A router.refresh() (the 5-minute
//     auto-refresh, the poll's own refresh) does not re-run the effect: the component stays mounted, the effect has no
//     changing dependency and a ref guards React strict mode's second mount. A per-tab sessionStorage guard keeps a REMOUNT (a
//     navigation back to Home) from calling it more than once per lane per 10 minutes. It is never called from a server render.
//   * while a run is open it shows "Updating summary…" (the previous summary stays on the page) and polls the cheap run state every
//     12 s for at most 3 minutes; when the run has ended it refreshes the page ONCE through requestRefresh (lib/refresh-gate.ts), so the
//     shared refresh clock stays correct, and waits while the reply drawer holds the refresh.
//   * a "⋯" disclosure (a button with aria-expanded / aria-controls; the panel is always rendered and hidden when closed) holding
//     "Regenerate": aria-disabled (not disabled, so the reason stays reachable) with "Available at <time>" within 30 minutes of the
//     last one, and with the daily limit when 6 runs were made today. Escape and focus leaving close it and focus returns to the
//     trigger; the trigger is 44 px on phones. The status live region is always mounted; only its text changes.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { briefingRunState, ensureFreshBriefing, regenerateBriefing, type BriefingStartState } from "@/app/[laneId]/briefing-actions";
import { DAILY_RUN_CAP, isStale, regenerateAvailableAt, type BriefingRunStateView } from "@/lib/briefing-runs";
import { isRefreshHeld, requestRefresh, subscribeRefreshGate } from "@/lib/refresh-gate";
import { POLL_EVERY_MS, POLL_FOR_MS } from "@/lib/client-constants";

const ENSURE_GUARD_MS = 10 * 60_000;

/** Per-tab guard: true when this lane asked for a fresh summary less than 10 minutes ago in this tab (sessionStorage). */
function ensuredRecently(laneId: string, nowMs: number): boolean {
  try {
    const key = `briefing-ensure:${laneId}`;
    const last = Number(window.sessionStorage.getItem(key));
    if (Number.isFinite(last) && last > 0 && nowMs - last < ENSURE_GUARD_MS) return true;
    window.sessionStorage.setItem(key, String(nowMs));
  } catch {
    /* storage unavailable: the server-side claim still decides */
  }
  return false;
}

const clock = (ms: number, tz: string): string => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  }
};

const START_MESSAGES: Record<string, string> = {
  forbidden: "Only the owner can regenerate the summary.",
  not_configured: "The AI is not set up for this deployment yet.",
  unavailable: "The summary could not be started. Try again in a minute.",
};

export function BriefingAuto({ laneId, preparedAt, initial, tz }: { laneId: string; preparedAt: string | null; initial: BriefingRunStateView | null; tz: string }) {
  const router = useRouter();
  const refreshRef = useRef(router.refresh);
  const [updating, setUpdating] = useState(initial?.running === true);
  const [state, setState] = useState<BriefingRunStateView | null>(initial);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Set when the menu opens or an action returns (never read during render): 0 = not yet known.
  const [nowMs, setNowMs] = useState(0);
  const menuId = useId();
  const triggered = useRef(false);
  const polling = useRef<{ timer: number; stop: () => void } | null>(null);
  const preparedRef = useRef(preparedAt);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    refreshRef.current = router.refresh;
    preparedRef.current = preparedAt;
  });

  const refreshOnce = useCallback(() => {
    const go = () => requestRefresh(refreshRef.current);
    if (!isRefreshHeld()) return go();
    const unsub = subscribeRefreshGate(() => {
      if (isRefreshHeld()) return;
      unsub();
      go();
    });
  }, []);

  const poll = useCallback(() => {
    if (polling.current) return;
    const startedAt = Date.now();
    const finish = (refresh: boolean) => {
      if (polling.current) window.clearInterval(polling.current.timer);
      polling.current = null;
      setUpdating(false);
      if (refresh) refreshOnce();
    };
    const timer = window.setInterval(() => {
      void briefingRunState(laneId).then((s) => {
        if (!polling.current) return;
        if (s) {
          setState(s);
          if (!s.running) return finish(true); // saved (a new summary or the failure reason): one refresh
        }
        if (Date.now() - startedAt >= POLL_FOR_MS) finish(false);
      });
    }, POLL_EVERY_MS);
    polling.current = { timer, stop: () => finish(false) };
    setUpdating(true);
  }, [laneId, refreshOnce]);

  // Once per page load. The ref also covers React strict mode's second mount in development.
  useEffect(() => {
    if (triggered.current) return;
    triggered.current = true;
    if (initial?.running) {
      poll();
      return;
    }
    if (!isStale(preparedRef.current, Date.now())) return;
    if (ensuredRecently(laneId, Date.now())) return;
    void ensureFreshBriefing(laneId).then((r) => {
      if ("started" in r && (r.started || r.gate === "running")) poll();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately once per page load
  }, []);

  useEffect(() => () => polling.current?.stop(), []);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const availableAt = nowMs === 0 ? null : regenerateAvailableAt(state?.lastRegenerateAt ?? null, nowMs);
  const capped = (state?.runsToday ?? 0) >= DAILY_RUN_CAP;
  const blocked = updating || availableAt !== null || capped;
  const reason = updating ? "Updating…" : capped ? `Daily limit reached (${String(DAILY_RUN_CAP)} a day)` : availableAt !== null ? `Available at ${clock(availableAt, tz)}` : null;

  const onRegenerate = async () => {
    if (blocked) return;
    setMessage(null);
    const r: BriefingStartState = await regenerateBriefing(laneId);
    if ("started" in r && r.started) {
      close(true);
      setNowMs(Date.now());
      setState((s) => (s ? { ...s, running: true, lastRegenerateAt: new Date().toISOString(), runsToday: s.runsToday + 1 } : s));
      poll();
      return;
    }
    if ("gate" in r) {
      const s = await briefingRunState(laneId);
      if (s) setState(s);
      setNowMs(Date.now());
      if (r.gate === "running") poll();
      return;
    }
    setMessage(START_MESSAGES[r.error] ?? START_MESSAGES.unavailable ?? null);
  };

  return (
    <div
      ref={wrapRef}
      className="relative flex items-center gap-2"
      onBlur={(e) => {
        // Focus left the whole control (not just moved between the trigger and the panel): close without stealing focus.
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {/* Always mounted so assistive tech announces the change of text, not the appearance of a node. */}
      <span role="status" aria-live="polite" data-testid="briefing-status" className="inline-flex items-center gap-1.5 text-small text-muted-foreground">
        {updating ? (
          <span data-testid="briefing-updating" className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2 animate-pulse rounded-full bg-muted-foreground" />
            Updating summary…
          </span>
        ) : message ? (
          <span data-testid="briefing-regenerate-message">{message}</span>
        ) : null}
      </span>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Summary options"
        aria-expanded={open}
        aria-controls={menuId}
        data-testid="briefing-menu-button"
        onClick={() => {
          setNowMs(Date.now());
          setOpen((o) => !o);
        }}
        className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:size-8"
      >
        <span aria-hidden>⋯</span>
      </button>
      <div id={menuId} hidden={!open} data-testid="briefing-menu" className="absolute right-0 top-11 z-20 min-w-48 rounded-md border border-border bg-card p-1 shadow-md sm:top-9">
        <button
          type="button"
          aria-disabled={blocked}
          data-testid="briefing-regenerate"
          onClick={() => void onRegenerate()}
          className={`flex min-h-11 w-full flex-col items-start rounded px-3 py-2 text-left text-small sm:min-h-0 ${blocked ? "cursor-not-allowed text-muted-foreground" : "text-foreground hover:bg-muted"}`}
        >
          <span>Regenerate</span>
          {reason ? (
            <span data-testid="briefing-regenerate-reason" className="text-small text-muted-foreground">
              {reason}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}
