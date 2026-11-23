"use client";
// Messages: the few things that need the browser (T-283, T-284). Each acts only on the person's own click, or once when a chat is opened; there is NO timer and NO polling here (Microsoft's
// terms: fetch when the page is opened, refreshed or a chat is opened). Nothing from a chat is stored in the browser (no localStorage, no cookie, no URL): messages live in component
// state for as long as the page is open. Every request is to this portal's own routes (lib/teams-api.ts); the browser never calls Microsoft.
//   MessagesRefresh   re-reads the page (a server refresh) on click
//   ConversationMessages  the conversation's messages, scrolled to the newest, with "Load older messages" (one more page per click)
//   CallButtons       Call and Video call (ask the server for the link, then open it in a new tab) and Open in Teams
//   MarkRead          once per opened chat: records the portal's own read marker
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { Button, buttonVariants, cn } from "@nichols/ui";
import type { CallState, MessageView } from "@/lib/teams-chats";
import { callUnavailableText, MESSAGES_NO_OLDER_TEXT, messagesBusyText } from "@/lib/teams-wording";
import { MessageList } from "./messages-view";

const JSON_HEADERS = { "content-type": "application/json" } as const;

type Failure = { text: string };
async function failureText(res: Response): Promise<string> {
  const b = (await res.json().catch(() => null)) as { error?: unknown; seconds?: unknown } | null;
  if (res.status === 429 || b?.error === "busy") return messagesBusyText(typeof b?.seconds === "number" ? b.seconds : null);
  if (b?.error === "reconnect") return "Your Teams sign-in expired. Reconnect Teams in Settings.";
  if (b?.error === "feature_missing") return "Reconnect Teams to add call buttons.";
  if (b?.error === "not_allowed") return "A call link is not available for this chat. Use Open in Teams.";
  return "Teams could not be reached. Try again.";
}

export function MessagesRefresh({ label = "Refresh" }: { label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => start(() => router.refresh())} data-testid="messages-refresh">
      {pending ? "Refreshing..." : label}
    </Button>
  );
}

export function ConversationMessages({ laneId, chatKey, initial, nextBefore, group }: { laneId: string; chatKey: string; initial: MessageView[]; nextBefore: string | null; group: boolean }) {
  const [older, setOlder] = useState<MessageView[]>([]);
  const [before, setBefore] = useState<string | null>(nextBefore);
  const [state, setState] = useState<{ busy: boolean; error: Failure | null }>({ busy: false, error: null });
  const box = useRef<HTMLDivElement>(null);
  const keep = useRef<{ height: number; top: number } | null>(null);

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
      const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/older?chat=${encodeURIComponent(chatKey)}&before=${encodeURIComponent(before)}`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        setState({ busy: false, error: { text: await failureText(res) } });
        return;
      }
      const b = (await res.json()) as { messages: MessageView[]; nextBefore: string | null };
      const el = box.current;
      keep.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
      setOlder((o) => [...b.messages, ...o]);
      setBefore(b.nextBefore);
      setState({ busy: false, error: null });
    } catch {
      setState({ busy: false, error: { text: "Teams could not be reached. Try again." } });
    }
  }

  const all = [...older, ...initial];
  return (
    <div ref={box} data-testid="conversation-scroll" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4">
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
      </div>
      <ul className="flex flex-col gap-3" data-testid="message-list">
        <MessageList messages={all} group={group} />
      </ul>
    </div>
  );
}

export function CallButtons({ laneId, chatKey, call, openUrl }: { laneId: string; chatKey: string; call: CallState; openUrl: string }) {
  const [state, setState] = useState<{ busy: "call" | "video" | null; error: string | null; link: string | null }>({ busy: null, error: null, link: null });
  const note = call === "available" ? null : callUnavailableText(call);

  async function press(video: boolean) {
    if (state.busy) return;
    setState({ busy: video ? "video" : "call", error: null, link: null });
    try {
      const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/call-link`, { method: "POST", headers: JSON_HEADERS, credentials: "same-origin", cache: "no-store", body: JSON.stringify({ chat: chatKey, video }) });
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
      const w = window.open(url, "_blank", "noopener,noreferrer");
      setState({ busy: null, error: null, link: w === null ? url : null });
    } catch {
      setState({ busy: null, error: "Teams could not be reached. Try again.", link: null });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="call-buttons">
      {call === "available" ? (
        <>
          <Button type="button" variant="outline" size="sm" disabled={state.busy !== null} onClick={() => void press(false)} data-testid="call-button">
            {state.busy === "call" ? "Opening..." : "Call"}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={state.busy !== null} onClick={() => void press(true)} data-testid="video-button">
            {state.busy === "video" ? "Opening..." : "Video call"}
          </Button>
        </>
      ) : null}
      <a href={openUrl} target="_blank" rel="noopener noreferrer" data-testid="open-in-teams" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
        Open in Teams
      </a>
      {state.link ? (
        <a href={state.link} target="_blank" rel="noopener noreferrer" data-testid="call-link" className="text-small font-medium text-primary underline underline-offset-2">
          Open the call in Teams
        </a>
      ) : null}
      {state.error ? (
        <p role="alert" data-testid="call-error" className="w-full text-small text-alert-foreground">
          {state.error}
        </p>
      ) : null}
      {note ? (
        <p data-testid="call-note" className="w-full text-small text-muted-foreground">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** Opening a chat records that the newest message shown has been seen (the portal's own marker). No UI: a failure only means the dot may come back. */
export function MarkRead({ laneId, chatKey, readThrough }: { laneId: string; chatKey: string; readThrough: string | null }) {
  useEffect(() => {
    if (readThrough === null) return;
    void fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/read`, { method: "POST", headers: JSON_HEADERS, credentials: "same-origin", cache: "no-store", body: JSON.stringify({ chat: chatKey, readThrough }) }).catch(() => undefined);
  }, [laneId, chatKey, readThrough]);
  return null;
}

