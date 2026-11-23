"use client";
// The "new" dot on Messages in the side menu and in the iPhone More list (T-290, spec 9.4). It draws NOTHING on the server and makes no read while a page renders: the answer is fetched here,
// in the browser, AFTER the shell has rendered, from `/api/lanes/<lane>/messages/activity` (the portal's own database, one row; never Microsoft). So no page gains a sequential level, and the
// shell stays a prefetchable static shell (no clock, no query, nothing dynamic before this effect runs). It asks on mount, when the page changes and when the tab becomes visible again,
// each at most once per DOT_MIN_GAP_MS, and has no timer. Without working notices the answer is "no dot" and nothing is drawn. Only the person who owns the Teams connection can ever get a dot:
// the route answers for the signed-in person's own connection and nobody else's.
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { dotSnapshot, refreshDot, subscribeDot } from "@/lib/messages-activity-client";
import { MESSAGES_NEW_DOT_LABEL } from "@/lib/teams-wording";

export function useMessagesDot(laneId: string): boolean {
  return useSyncExternalStore(
    (cb) => subscribeDot(laneId, cb),
    () => dotSnapshot(laneId),
    () => false,
  );
}

/**
 * `onDark`: the navy side menu (raw gold, 7:1 or better in both themes). Otherwise the card surface of the More tab and list: `gold-foreground` (the token for gold that carries meaning on a light surface:
 * 5:1 on white in the light theme, 8:1 on the dark card in the dark theme; raw gold on white is about 2:1).
 */
export function MessagesDot({ laneId, onDark = false }: { laneId: string; onDark?: boolean }) {
  const dot = useMessagesDot(laneId);
  const pathname = usePathname();
  useEffect(() => {
    void refreshDot(laneId);
  }, [laneId, pathname]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshDot(laneId);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [laneId]);
  if (!dot) return null;
  return (
    <>
      <span aria-hidden="true" data-testid="messages-dot" className={`ml-auto inline-block size-2.5 shrink-0 rounded-full ${onDark ? "bg-gold" : "bg-gold-foreground"}`} />
      <span className="sr-only">{MESSAGES_NEW_DOT_LABEL}</span>
    </>
  );
}
