"use client";
// Settings -> Connections, the "Last sync" cell of your own Teams account (T-289, T-290, T-295; spec 9.1, 22.7, H-083 step 3): the fixed text it always had, and, once the browser has asked the portal's own
// database (`/api/lanes/<lane>/messages/activity`: never Microsoft, no read while the page renders), either "Live updates until <time>" (Microsoft's expiry of the notice subscription, Eastern Time) or
// "Live updates unavailable" (notices are not configured, were refused, or the lifetime Microsoft gave was too short: the page then offers Refresh). It says nothing before the answer.
// With several accounts each row names its connection and shows ITS OWN live state, from its entry in `accounts`; the rows of one page share ONE request (`getActivityShared`).
import { useEffect, useState } from "react";
import { getActivityShared } from "@/lib/messages-activity-client";
import { fullTime } from "@/lib/teams-format";
import { MESSAGES_LIVE_OFF_TEXT, messagesLiveUntilText } from "@/lib/teams-wording";

export function TeamsLiveStatus({ laneId, connectionId, children }: { laneId: string; /** The connection this row is for (T-295). Without it the answer for the whole person is used (one account). */ connectionId?: string; children: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getActivityShared(laneId).then((a) => {
      if (a === null || cancelled) return;
      // an entry of this connection, else (an older server, or no per-account list) the answer for the whole person
      const own = connectionId === undefined ? undefined : a.accounts.find((x) => x.conn === connectionId);
      const view = own ?? (a.accounts.length === 0 || connectionId === undefined ? a : { live: false, liveUntil: null });
      setText(view.live && view.liveUntil !== null ? messagesLiveUntilText(fullTime(view.liveUntil)) : MESSAGES_LIVE_OFF_TEXT);
    });
    return () => {
      cancelled = true;
    };
  }, [laneId, connectionId]);
  return (
    <>
      {children}
      {text !== null ? (
        <span className="block" data-testid="teams-live-status">
          {text}
        </span>
      ) : null}
    </>
  );
}
