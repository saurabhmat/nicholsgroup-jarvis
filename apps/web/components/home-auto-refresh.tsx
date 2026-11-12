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
import { isRefreshHeld, subscribeRefreshGate } from "@/lib/refresh-gate";

export const REFRESH_INTERVAL_MS = 5 * 60_000;
const LABEL_TICK_MS = 30_000;
const TEXT_FIELD = 'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="reset"]):not([type="file"]), textarea, select, [contenteditable]:not([contenteditable="false"])';

/** A text field (or select, or editable region) has the focus: the owner may be typing. */
export function textFieldFocused(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLElement && a !== document.body && a.matches(TEXT_FIELD);
}

export function updatedLabel(updatedAtMs: number, nowMs: number): string {
  const min = Math.floor(Math.max(0, nowMs - updatedAtMs) / 60_000);
  if (min < 1) return "Updated just now";
  if (min < 60) return `Updated ${String(min)} min ago`;
  const h = Math.floor(min / 60);
  return `Updated ${String(h)} h ago`;
}

export function HomeAutoRefresh({ renderedAt, intervalMs = REFRESH_INTERVAL_MS, labelTickMs = LABEL_TICK_MS }: { renderedAt: string; intervalMs?: number; labelTickMs?: number }) {
  const router = useRouter();
  const renderedMs = Date.parse(renderedAt);
  const serverMs = Number.isNaN(renderedMs) ? 0 : renderedMs;
  const refreshRef = useRef(router.refresh);
  const lastAttempt = useRef(0);
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
    const doRefresh = () => {
      lastAttempt.current = Date.now();
      refreshRef.current();
    };
    // Focus, visibility and the end of a pause: refresh only when the data is older than the interval.
    const catchUp = () => {
      if (!canRefresh()) return;
      if (Date.now() - Math.max(updatedRef.current, lastAttempt.current) >= intervalMs) doRefresh();
    };
    const tick = window.setInterval(() => {
      if (canRefresh()) doRefresh();
    }, intervalMs);
    const label = window.setInterval(() => setNowMs(Date.now()), labelTickMs);
    const onFocusOut = () => window.setTimeout(catchUp, 0); // activeElement is settled after the event
    document.addEventListener("visibilitychange", catchUp);
    window.addEventListener("focus", catchUp);
    document.addEventListener("focusout", onFocusOut);
    const unsub = subscribeRefreshGate(catchUp);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(label);
      document.removeEventListener("visibilitychange", catchUp);
      window.removeEventListener("focus", catchUp);
      document.removeEventListener("focusout", onFocusOut);
      unsub();
    };
  }, [intervalMs, labelTickMs]);

  const shown = Math.max(nowMs, serverMs);
  return (
    <span data-testid="home-updated" className="text-small text-muted-foreground" title={mounted && serverMs ? `Data read at ${new Date(serverMs).toLocaleTimeString()}` : undefined}>
      {updatedLabel(serverMs, shown)}
    </span>
  );
}
