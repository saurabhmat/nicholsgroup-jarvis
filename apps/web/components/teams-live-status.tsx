"use client";
// Settings -> Connections, the "Last sync" cell of your own Teams account (T-289, T-290; spec 9.1, H-083 step 3): the fixed text it always had, and, once the browser has asked the portal's own database
// (`/api/lanes/<lane>/messages/activity`: never Microsoft, no read while the page renders), either "Live updates until <time>" (Microsoft's expiry of the notice subscription, Eastern Time) or
// "Live updates unavailable" (notices are not configured, were refused, or the lifetime Microsoft gave was too short: the page then offers Refresh). It says nothing before the answer.
import { useEffect, useState } from "react";
import { getActivity } from "@/lib/messages-activity-client";
import { fullTime } from "@/lib/teams-format";
import { MESSAGES_LIVE_OFF_TEXT, messagesLiveUntilText } from "@/lib/teams-wording";

export function TeamsLiveStatus({ laneId, children }: { laneId: string; children: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    void getActivity(laneId, ac.signal).then((a) => {
      if (a === null || ac.signal.aborted) return;
      setText(a.live && a.liveUntil !== null ? messagesLiveUntilText(fullTime(a.liveUntil)) : MESSAGES_LIVE_OFF_TEXT);
    });
    return () => ac.abort();
  }, [laneId]);
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
