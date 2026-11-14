"use client";
// Home auto-refresh (T-234 part 5): re-reads the page's data every 5 minutes without losing the owner's work, and shows
// "Updated 2 min ago" in the header. It only ever calls router.refresh(), which re-renders the server components with current
// data: it never calls a server action, never starts the AI briefing, a news fetch or a sync (Home's loaders are read only).
// Rules:
//   * the interval ticks only while the tab is visible; coming back to the tab (visibilitychange / focus) refreshes if the last
//     update is older than the interval;
//   * paused while the Reply drawer is open or a send is in progress (lib/refresh-gate.ts) or a text field has the focus; the
//     catch-up refresh runs once when the pause ends and the data is stale;
//   * client state (the drawer, edited fields, expanded sections) is React state above the refreshed server output, so it survives;
//     what a full reload would lose is also in sessionStorage (home-scope.tsx, reply-draft-store.ts).
// The "Updated" text changes silently (no live region); its title holds the absolute time.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isRefreshHeld, lastRefreshAttempt, requestRefresh, subscribeRefreshGate } from "@/lib/refresh-gate";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const LABEL_TICK_MS = 30_000;
const SLACK_MS = 5_000; // a tick fires a moment before the previous refresh's render time + the interval
const TEXT_FIELD = 'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="reset"]):not([type="file"]), textarea, select, [contenteditable]:not([contenteditable="false"])';

/** A text field (or select, or editable region) has the focus: the owner may be typing. */
export function textFieldFocused(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLElement && a !== document.body && a.matches(TEXT_FIELD);
}

/** The absolute time in the viewer's zone, America/New_York for a missing or unknown zone (T-237: never the browser's zone, never ISO). */
function timeLabel(ms: number, tz?: string): string {
  const fmt = (zone: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: zone }).format(new Date(ms));
  try {
    return fmt(tz || "America/New_York");
  } catch {
    return fmt("America/New_York");
  }
}

export function updatedLabel(updatedAtMs: number, nowMs: number): string {
  const min = Math.floor(Math.max(0, nowMs - updatedAtMs) / 60_000);
  if (min < 1) return "Updated just now";
  if (min < 60) return `Updated ${String(min)} min ago`;
  const h = Math.floor(min / 60);
  return `Updated ${String(h)} h ago`;
}

export function HomeAutoRefresh({ renderedAt, tz, intervalMs = REFRESH_INTERVAL_MS, labelTickMs = LABEL_TICK_MS }: { renderedAt: string; tz?: string; intervalMs?: number; labelTickMs?: number }) {
  const router = useRouter();
  const renderedMs = Date.parse(renderedAt);
  const serverMs = Number.isNaN(renderedMs) ? 0 : renderedMs;
  const refreshRef = useRef(router.refresh);
  const updatedRef = useRef(serverMs);
  // The server render time is the last successful update; the first client render shows it too (no hydration mismatch).
  const [nowMs, setNowMs] = useState(serverMs);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    refreshRef.current = router.refresh;
    updatedRef.current = serverMs;
  });

  useEffect(() => {
    queueMicrotask(() => {
      setMounted(true);
      setNowMs(Date.now());
    });
    const canRefresh = () => document.visibilityState === "visible" && !isRefreshHeld() && !textFieldFocused();
    // The timer, focus, visibility and the end of a pause all ask the same question: is the data (or the last attempt) older than
    // the interval? The attempt time is shared with the drawer's own refresh (lib/refresh-gate.ts).
    const catchUp = () => {
      if (!canRefresh()) return;
      if (Date.now() - Math.max(updatedRef.current, lastRefreshAttempt()) >= intervalMs - SLACK_MS) requestRefresh(refreshRef.current);
    };
    const tick = window.setInterval(catchUp, intervalMs);
    const label = window.setInterval(() => setNowMs(Date.now()), labelTickMs);
    let focusTimer: number | undefined;
    const onFocusOut = () => {
      window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(catchUp, 0); // activeElement is settled after the event
    };
    document.addEventListener("visibilitychange", catchUp);
    window.addEventListener("focus", catchUp);
    document.addEventListener("focusout", onFocusOut);
    const unsub = subscribeRefreshGate(catchUp);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(label);
      window.clearTimeout(focusTimer);
      document.removeEventListener("visibilitychange", catchUp);
      window.removeEventListener("focus", catchUp);
      document.removeEventListener("focusout", onFocusOut);
      unsub();
    };
  }, [intervalMs, labelTickMs]);

  const shown = Math.max(nowMs, serverMs);
  return (
    <span data-testid="home-updated" className="text-small text-muted-foreground max-md:hidden" title={mounted && serverMs ? `Data read at ${timeLabel(serverMs, tz)}` : undefined}>
      {updatedLabel(serverMs, shown)}
    </span>
  );
}
