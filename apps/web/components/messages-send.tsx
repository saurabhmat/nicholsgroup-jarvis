"use client";
// Messages: the Send box (T-288; spec docs/specs/messages.md 10.3, 10.5, 22.8; decision D-67). The composer belongs to the conversation opened through `conn` (one account) and sends through THAT connection only; the line
// under it names the account. Pressing Send is the person's approval of the exact text: the browser hashes the text it shows and the route proposes, approves and sends it in one request (one POST at Microsoft).
// What is kept where: the typed text lives in this component's state; a copy is kept in THIS TAB's sessionStorage (components never reach the server with it except in the send request) only so a stale authenticator
// code does not cost it (lib/reply-draft-store.ts, `teamsDrafts`: only for a company that stores outbound drafts, which a Teams composer requires). Nothing is stored after a send leaves the person's hands.
//   SendScope       the bubbles of this conversation's sends (state), shared by the composer and the message list
//   PendingBubbles  those bubbles, drawn at the end of the message list, each with its state as TEXT (never colour alone), announced by a live region; a Sent bubble is hidden once the conversation shows that message
//   Composer        the text box, counter, Send button and the line under it
// No ref is read and no clock is called while rendering (react-hooks/refs, react-hooks/purity): time and ids are made in event handlers.
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, cn } from "@nichols/ui";
import { hrefFor } from "@/lib/messages-href";
import { debounced, teamsDrafts } from "@/lib/reply-draft-store";
import { newRequestId, normalizeSendText, SEND_MAX_CHARS, sendCharCount, sendTextHash, sendTextProblem } from "@/lib/teams-send-text";
import type { MessageView } from "@/lib/teams-chats";
import { MESSAGES_SEND_HINT_DESKTOP, SEND_ERROR_TEXT, SEND_NETWORK_TEXT, SEND_STATE_TEXT, SEND_STEP_UP_TEXT, SEND_TEXT_PROBLEM, teamsSendLine, type SendState } from "@/lib/teams-wording";
import { useMessagesLive } from "./messages-live";
import { MessageBubble } from "./messages-bubble";

export type SendItem = {
  /** The client request id of this composed message (also the React key). */
  id: string;
  /** What was sent (the person's own text, in this tab's memory only). */
  text: string;
  state: SendState;
  /** A fixed sentence for `not_sent` (never text from Teams or the message). */
  reason: string | null;
  /** When it was pressed (ms), for hiding a Sent bubble once the conversation shows the message from Teams. Made in the event handler. */
  at: number;
};

type SendApi = { items: readonly SendItem[]; put(item: SendItem): void; patch(id: string, p: Partial<SendItem>): void; drop(id: string): void; dropNotSent(): void };
const SendCtx = createContext<SendApi | null>(null);
const useSend = (): SendApi | null => useContext(SendCtx);

export function SendScope({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<readonly SendItem[]>([]);
  const put = useCallback((item: SendItem) => setItems((xs) => [...xs.filter((x) => x.id !== item.id), item]), []);
  const patch = useCallback((id: string, p: Partial<SendItem>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x))), []);
  const drop = useCallback((id: string) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const dropNotSent = useCallback(() => setItems((xs) => xs.filter((x) => x.state !== "not_sent")), []);
  const api = useMemo<SendApi>(() => ({ items, put, patch, drop, dropNotSent }), [items, put, patch, drop, dropNotSent]);
  return <SendCtx.Provider value={api}>{children}</SendCtx.Provider>;
}

// ---- matching a sent message to the one Teams returns (so the next read shows ONE bubble, not two)
const squash = (s: string): string => normalizeSendText(s).replace(/\s+/g, " ");
type Node = MessageView["nodes"][number];
function nodesText(nodes: readonly Node[]): string {
  return nodes
    .map((n) => {
      if (n.t === "text" || n.t === "mention" || n.t === "emoji") return n.v;
      if (n.t === "br") return "\n";
      if (n.t === "image") return "";
      return "c" in n ? ` ${nodesText(n.c)} ` : "";
    })
    .join("");
}
/** Whether the conversation already shows this sent message from Teams: one of the person's own, not before the press (2 minutes of clock skew), with the same text. */
export function shownFromTeams(item: Pick<SendItem, "text" | "at">, messages: readonly MessageView[]): boolean {
  const want = squash(item.text);
  return messages.some((m) => m.mine && !m.deleted && !m.system && Date.parse(m.at) >= item.at - 120_000 && squash(nodesText(m.nodes)) === want);
}

const STATE_GLYPH: Record<SendState, string> = { sending: "…", sent: "✓", checking: "✓…", not_sent: "!", unknown: "?" };

/** The sent messages not yet shown by the conversation itself, newest last, inside the list. `shown`: the messages the conversation holds now. */
export function PendingBubbles({ shown }: { shown: readonly MessageView[] }) {
  const send = useSend();
  const end = useRef<HTMLLIElement>(null);
  const items = (send?.items ?? []).filter((i) => !((i.state === "sent" || i.state === "checking") && shownFromTeams(i, shown)));
  // the newest sent message is what the person is looking at: keep it in view when one is added or changes state
  const marker = items.map((i) => `${i.id}:${i.state}`).join(",");
  useEffect(() => {
    if (marker !== "") end.current?.scrollIntoView?.({ block: "end" });
  }, [marker]);
  if (!send) return null;
  return (
    <>
      {items.map((i) => (
        <li key={i.id} data-testid="send-item" data-state={i.state} className="flex w-full min-w-0 flex-col items-end gap-0.5">
          <MessageBubble mine fullTime="">
            <div dir="auto" data-testid="send-text" className="min-w-0 whitespace-pre-wrap text-body [overflow-wrap:anywhere]">
              {i.text}
            </div>
          </MessageBubble>
          <p data-testid="send-state" className={cn("flex items-baseline gap-1 px-1 text-small", i.state === "not_sent" ? "font-medium text-alert-foreground" : "text-muted-foreground")}>
            <span aria-hidden>{STATE_GLYPH[i.state]}</span>
            <span>{SEND_STATE_TEXT[i.state]}</span>
            {i.state === "not_sent" && i.reason ? <span>: {i.reason}</span> : null}
          </p>
        </li>
      ))}
      <li ref={end} aria-hidden className="h-0" />
    </>
  );
}

const control = "min-h-11 w-full min-w-0 resize-none rounded-control border border-border bg-card px-3 py-2 text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring max-lg:text-base";

type Answer = { state?: unknown; error?: unknown; message?: unknown };

/**
 * The composer. `userId` is only a key part of the tab's draft (it never decides access). `connectionLabel` is the account's sign-in address (the line under the box).
 */
export function Composer({ laneId, conn, chatKey, account, userId }: { laneId: string; conn: string; chatKey: string; account: string; userId: string }) {
  const router = useRouter();
  const send = useSend();
  const live = useMessagesLive();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const inFlight = useRef(false);
  const requestId = useRef<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const draftId = `${conn}:${chatKey}`;
  const writer = useMemo(() => debounced((t: string) => (t === "" ? teamsDrafts.remove(laneId, userId, draftId) : void teamsDrafts.write(laneId, userId, draftId, { text: t })), 500), [laneId, userId, draftId]);
  // the text kept in this tab (a stale authenticator code, a reload): put back once when the composer opens
  useEffect(() => {
    const kept = teamsDrafts.read(laneId, userId, draftId);
    if (kept) setText((cur) => (cur === "" ? kept.text : cur)); // eslint-disable-line react-hooks/set-state-in-effect -- reads the tab's own storage once after mount (never during render)
    return () => writer.flush();
  }, [laneId, userId, draftId, writer]);

  const problem = sendTextProblem(text);
  const count = sendCharCount(text);
  const canSend = problem === null && !busy;

  const say = (s: string) => setAnnounce(s);
  function edit(v: string) {
    setText(v);
    setNote(null);
    writer.call(v);
  }

  async function press() {
    if (inFlight.current) return; // a double click or a held key is the same press
    const t = text;
    if (sendTextProblem(t) !== null) return;
    inFlight.current = true;
    setBusy(true);
    setNote(null);
    const id = requestId.current ?? newRequestId();
    const canonical = normalizeSendText(t);
    const hash = await sendTextHash(canonical);
    if (id === null || hash === null) {
      setNote("This browser cannot prepare the message safely, so nothing was sent.");
      inFlight.current = false;
      setBusy(false);
      return;
    }
    requestId.current = id; // kept until the answer says this id is done: a repeated request with it can never post twice
    send?.dropNotSent();
    send?.put({ id, text: canonical, state: "sending", reason: null, at: Date.now() });
    say(SEND_STATE_TEXT.sending);
    const finish = (state: SendState, reason: string | null, keepText: boolean) => {
      send?.patch(id, { state, reason });
      say(state === "not_sent" ? `${SEND_STATE_TEXT.not_sent}${reason ? `: ${reason}` : ""}` : SEND_STATE_TEXT[state]);
      requestId.current = null; // a new press after this is a NEW message (never a resend of one that may have gone)
      if (!keepText) {
        setText("");
        writer.cancel();
        teamsDrafts.remove(laneId, userId, draftId);
      }
    };
    try {
      const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ conn, chat: chatKey, text: t, textSha256: hash, clientRequestId: id }),
      });
      const b = (await res.json().catch(() => null)) as Answer | null;
      if (res.status === 403 && b?.error === "step_up_required") {
        // The server holds nothing (it stopped before proposing). Keep the text in this tab and send the person to enter the code; they come back to this chat.
        send?.drop(id);
        requestId.current = null;
        writer.cancel();
        teamsDrafts.write(laneId, userId, draftId, { text: t });
        setNote(SEND_STEP_UP_TEXT);
        say(SEND_STEP_UP_TEXT);
        const back = hrefFor(laneId, chatKey, null, conn);
        router.push(`/mfa?reauth=1&next=${encodeURIComponent(back.length <= 480 ? back : `/${laneId}/messages`)}`);
        return;
      }
      if (res.ok && b && typeof b.state === "string") {
        if (b.state === "sent") {
          finish("sent", null, false);
          live?.requestRefresh("refresh"); // the next read shows the message from Teams (the bubble then yields to it); at most once a minute, a failure is fine
        } else if (b.state === "checking") finish("checking", null, false);
        else if (b.state === "not_sent") finish("not_sent", typeof b.message === "string" ? b.message : SEND_ERROR_TEXT.unavailable ?? null, true);
        else finish("unknown", null, false); // it may have gone: the text leaves the box (never a blind resend); the bubble shows what was sent
        return;
      }
      // a refusal before anything was proposed: nothing was sent, the text stays
      const code = typeof b?.error === "string" ? b.error : "unavailable";
      if (code === "unknown_outcome" || res.status === 502 || res.status === 504) return finish("unknown", null, false); // the approvals entry was reached: it may have gone
      finish("not_sent", SEND_ERROR_TEXT[code] ?? SEND_ERROR_TEXT.unavailable ?? null, true);
    } catch {
      // no answer (network, a timeout): the request may have reached the server and Teams. Never a retry from here.
      send?.patch(id, { state: "unknown", reason: SEND_NETWORK_TEXT });
      say(SEND_STATE_TEXT.unknown);
      requestId.current = null;
      setText("");
      writer.cancel();
      teamsDrafts.remove(laneId, userId, draftId);
    } finally {
      inFlight.current = false;
      setBusy(false);
      box.current?.focus();
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    // desktop only: on a phone only the button sends (an accidental key must never be an approval)
    if (typeof window.matchMedia === "function" && !window.matchMedia("(min-width: 1024px)").matches) return;
    e.preventDefault();
    void press();
  }

  return (
    <form
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void press();
      }}
      className="flex min-w-0 flex-col gap-1 py-1"
    >
      <div className="flex min-w-0 items-end gap-2">
        <textarea
          ref={box}
          value={text}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          aria-label="Message to send in Teams (plain text)"
          aria-describedby="composer-line composer-count"
          data-testid="composer-text"
          className={cn(control, "max-h-40 min-h-[2.75rem]")}
        />
        <Button type="submit" aria-disabled={!canSend ? true : undefined} data-testid="composer-send" className="min-h-11 shrink-0" onClick={(e) => !canSend && e.preventDefault()}>
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
      <p className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 text-small text-muted-foreground">
        <span id="composer-line" data-testid="composer-line" className="min-w-0 [overflow-wrap:anywhere]">
          {teamsSendLine(account)}
        </span>
        <span id="composer-count" data-testid="composer-count" className={cn("shrink-0", problem === "too_long" && "font-medium text-alert-foreground")}>
          {count.toLocaleString("en-US")} / {SEND_MAX_CHARS.toLocaleString("en-US")}
        </span>
      </p>
      <p data-testid="composer-hint" className="hidden text-small text-muted-foreground lg:block">
        {MESSAGES_SEND_HINT_DESKTOP}
      </p>
      {problem !== null && problem !== "empty" ? (
        <p data-testid="composer-problem" className="text-small text-alert-foreground">
          {SEND_TEXT_PROBLEM[problem]}
        </p>
      ) : null}
      {note ? (
        <p data-testid="composer-note" className="text-small font-medium text-foreground">
          {note}
        </p>
      ) : null}
      <span role="status" aria-live="polite" data-testid="composer-announce" className="sr-only">
        {announce}
      </span>
    </form>
  );
}
