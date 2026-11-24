"use client";
// Messages: the Send box (T-288; spec docs/specs/messages.md 10.3, 10.5, 22.8; decision D-67; review fixes A to C). The composer belongs to the conversation opened through `conn` (one account) and sends
// through THAT connection only; the line under it names the account. Pressing Send is the person's approval of the exact text: the browser hashes the text it shows and the route proposes, approves and
// sends it in one request (one POST at Microsoft).
// THE ONE RULE FOR THE REQUEST ID: the id belongs to the exact text of one intended message, not to one press. It is made at the first press for a text and KEPT for that text until the server has confirmed
// a terminal outcome (sent, checking, or a definite not-sent from an action that was proposed). Every later press with unchanged text reuses it (after a rate limit, a step-up, a gate refusal, an
// unavailable answer, a lost answer, a reload), so the server (one action per connection + id) can never post twice. A changed text, or a confirmed terminal outcome, makes a new id.
// THE IN-FLIGHT MARKER (lib/teams-send-marker.ts) is written to this tab's session storage before the request leaves and removed when an answer is confirmed. A composer that opens on a marker without an
// answer (the person left the chat, reloaded, closed the tab) shows "This message may have been sent..." with Check again (the SAME id and text: safe) and Discard; it never puts the text back in the box.
// "Not sent" is said ONLY for the route's own JSON refusals with a known code; every other answer (a 5xx that is not the route's own JSON 503, a body that is not JSON, a dropped connection) is Outcome unknown.
//   SendScope       the engine and the bubbles of this conversation's sends, shared by the composer and the message list
//   PendingBubbles  those bubbles, each with its state as TEXT (never colour alone); a Sent bubble is hidden once the conversation shows that very message (by id, else one to one by text)
//   Composer        the text box, counter, Send button and the line under it
// No ref is read and no clock is called while rendering (react-hooks/refs, react-hooks/purity): time and ids are made in event handlers.
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, cn } from "@nichols/ui";
import { hrefFor } from "@/lib/messages-href";
import { debounced, noteSignedInUser, teamsDrafts } from "@/lib/reply-draft-store";
import { readMarker, removeMarker, subscribeMarker, writeMarker, type SendMarker } from "@/lib/teams-send-marker";
import { newRequestId, normalizeSendText, SEND_MAX_CHARS, sendCharCount, sendTextHash, sendTextProblem } from "@/lib/teams-send-text";
import type { MessageView } from "@/lib/teams-chats";
import { MESSAGES_SEND_HINT_DESKTOP, SEND_CHECK_AGAIN, SEND_DISCARD, SEND_DISCARDED_TEXT, SEND_ERROR_TEXT, SEND_MAYBE_SENT_TEXT, SEND_NETWORK_TEXT, SEND_STATE_TEXT, SEND_STEP_UP_TEXT, SEND_TEXT_PROBLEM, teamsSendLine, type SendState } from "@/lib/teams-wording";
import { useMessagesLive } from "./messages-live";
import { MessageBubble } from "./messages-bubble";

export type SendItem = {
  /** The request id of this composed message (also the React key). */
  id: string;
  /** What was sent (the person's own text, in this tab's memory and its session storage only). */
  text: string;
  state: SendState;
  /** A fixed sentence (never text from Teams or the message). */
  reason: string | null;
  /** When it was pressed (ms), for matching the message Teams returns. Made in the event handler. */
  at: number;
  /** The Graph id of the message when the server confirmed it (`sent`). */
  messageId: string | null;
  /** The person dismissed the check of an unknown outcome. */
  closed: boolean;
};

type Answer = { kind: "sent"; messageId: string | null } | { kind: "checking" } | { kind: "not_sent"; reason: string } | { kind: "refused"; code: string; reason: string; fresh: boolean } | { kind: "stepup" } | { kind: "unknown"; reason: string | null };

/** What an answer from the route means, by the rule in the header: only the route's own JSON with a known code is a definite refusal. */
export function classifyAnswer(status: number, body: unknown): Answer {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  if (b === null) return { kind: "unknown", reason: null }; // not JSON, not parseable, an HTML error page of the platform
  if (status >= 200 && status < 300 && b.ok === true && typeof b.state === "string") {
    if (b.state === "sent") return { kind: "sent", messageId: typeof b.messageId === "string" ? b.messageId : null };
    if (b.state === "checking") return { kind: "checking" };
    if (b.state === "not_sent") return { kind: "not_sent", reason: typeof b.message === "string" ? b.message : (SEND_ERROR_TEXT.unavailable ?? "") };
    return { kind: "unknown", reason: null };
  }
  const code = typeof b.error === "string" ? b.error : "";
  if (code === "step_up_required" && status === 403) return { kind: "stepup" };
  if (code === "unknown_outcome") return { kind: "unknown", reason: null };
  const known = code !== "" && Object.prototype.hasOwnProperty.call(SEND_ERROR_TEXT, code);
  // `unavailable` is the route's own 503 (a read failed before anything was proposed); a 5xx with any other body is the platform's or an unclassified failure after the entry started
  if (!known || (status >= 500 && !(code === "unavailable" && status === 503))) return { kind: "unknown", reason: null };
  return { kind: "refused", code, reason: SEND_ERROR_TEXT[code] ?? "", fresh: b.fresh === true };
}

/** The text of the live region after announcing `s`: the same words twice in a row get a zero-width mark toggled on, so the text node changes and a screen reader says them again. */
export const nextAnnounce = (prev: string, s: string): string => (prev.replaceAll("\u200b", "") === s ? (prev.endsWith("\u200b") ? s : `${s}\u200b`) : s);

type Press = { clear: boolean };
type SendApi = {
  items: readonly SendItem[];
  busy: boolean;
  /** Sends the (raw) text. `clear`: the box may be emptied (if it still holds exactly this text). */
  press(raw: string): Promise<Press>;
  checkAgain(id: string): Promise<void>;
  discard(id: string): void;
  /** Text to put back into an empty box (a late "not sent" answer found on return). */
  restore: { text: string; n: number } | null;
  /** A note for the composer (a step-up, a refused sign-in, an unsaved copy). */
  note: { text: string; href?: string; link?: string } | null;
  setNote(n: { text: string; href?: string; link?: string } | null): void;
  announce: string;
};
const SendCtx = createContext<SendApi | null>(null);
const useSend = (): SendApi | null => useContext(SendCtx);

type ScopeProps = { laneId: string; conn: string; chatKey: string; userId: string; enabled: boolean; children: ReactNode };

export function SendScope({ laneId, conn, chatKey, userId, enabled, children }: ScopeProps) {
  const router = useRouter();
  const live = useMessagesLive();
  const [items, setItems] = useState<readonly SendItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [restore, setRestore] = useState<{ text: string; n: number } | null>(null);
  const [note, setNote] = useState<SendApi["note"]>(null);
  const [announce, setAnnounce] = useState("");
  const inFlight = useRef(false);
  const idFor = useRef<{ text: string; id: string } | null>(null); // the request id of the text that is being composed
  const alive = useRef(true);
  const where = useMemo(() => ({ laneId, userId, item: `${conn}:${chatKey}` }), [laneId, userId, conn, chatKey]);
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  });

  const say = useCallback((s: string) => setAnnounce((prev) => nextAnnounce(prev, s)), []);
  const upsert = useCallback((item: SendItem) => setItems((xs) => (xs.some((x) => x.id === item.id) ? xs.map((x) => (x.id === item.id ? item : x)) : [...xs, item])), []);
  const patch = useCallback((id: string, p: Partial<SendItem>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x))), []);

  // A marker from before (another visit, a reload, a closed tab) or a late answer for a chat that was left: shown, never put back into the box (except a confirmed "not sent").
  useEffect(() => {
    alive.current = true;
    if (!enabled) return undefined;
    noteSignedInUser(userId); // another person signing in in this tab clears the previous person's tab copies before anything is read
    const adopt = (m: SendMarker | null) => {
      if (m === null) return;
      const base: SendItem = { id: m.id, text: m.text, state: "unknown", reason: SEND_MAYBE_SENT_TEXT, at: m.startedAt, messageId: null, closed: false };
      if (m.state === "sent" || m.state === "checking") {
        upsert({ ...base, state: m.state, reason: null, messageId: m.messageId });
        removeMarker(where);
        idFor.current = null;
      } else if (m.state === "not_sent") {
        upsert({ ...base, state: "not_sent", reason: m.reason });
        removeMarker(where);
        idFor.current = null;
        setRestore((r) => ({ text: m.text, n: (r?.n ?? 0) + 1 }));
      } else {
        upsert(base);
        idFor.current = { text: m.text, id: m.id };
      }
    };
    adopt(readMarker(where));
    const off = subscribeMarker(where, (m) => {
      if (m && !inFlight.current) adopt(m);
    });
    return () => {
      alive.current = false;
      off();
    };
  }, [enabled, userId, where, upsert]);

  // one request for (text, id, hash): the marker first, then the request, then what the answer means
  const submit = useCallback(
    async (canonical: string, id: string, hash: string, startedAt: number, text: { raw: string | null }): Promise<Press> => {
      inFlight.current = true;
      setBusy(true);
      const marker: SendMarker = { id, hash, text: canonical, startedAt, state: "inflight", messageId: null, reason: null };
      writeMarker(where, marker); // synchronously, before the request leaves
      upsert({ id, text: canonical, state: "sending", reason: null, at: startedAt, messageId: null, closed: false });
      say(SEND_STATE_TEXT.sending);
      const finish = (a: Answer): Press => {
        const final = (state: SendState, reason: string | null, messageId: string | null) => {
          patch(id, { state, reason, messageId });
          say(state === "not_sent" ? `${SEND_STATE_TEXT.not_sent}${reason ? `: ${reason}` : ""}` : SEND_STATE_TEXT[state]);
        };
        if (a.kind === "sent" || a.kind === "checking") {
          const state = a.kind === "sent" ? "sent" : "checking";
          const messageId = a.kind === "sent" ? a.messageId : null;
          final(state, null, messageId);
          idFor.current = null;
          if (alive.current) removeMarker(where);
          else writeMarker(where, { ...marker, state, messageId }); // a late answer after the chat was left: the right state shows on return
          if (a.kind === "sent") liveRef.current?.requestRefresh("refresh"); // one re-read; at most once a minute, a refusal is fine
          return { clear: true };
        }
        if (a.kind === "unknown") {
          final("unknown", a.reason ?? SEND_STATE_TEXT.unknown, null);
          // the id is kept for this text: a press with the same text asks the server about the same action
          writeMarker(where, { ...marker, state: "unknown" }); // kept: on return, or for Check again, the bubble is rebuilt from it
          return { clear: true };
        }
        // a definite answer: nothing was sent
        if (a.kind === "not_sent") {
          final("not_sent", a.reason, null); // an action that was proposed and ended without sending: terminal, so the next press is a new message
          idFor.current = null;
          if (alive.current) removeMarker(where);
          else writeMarker(where, { ...marker, state: "not_sent", reason: a.reason });
          return { clear: false };
        }
        if (a.kind === "refused") {
          final("not_sent", a.reason, null);
          if (a.fresh) idFor.current = null; // the proposal was rejected on the spot: a replay would find it, so the next press needs a new id; otherwise the SAME id is kept for the same text
          if (alive.current) removeMarker(where);
          else writeMarker(where, { ...marker, state: "not_sent", reason: a.reason });
          return { clear: false };
        }
        return { clear: false };
      };
      try {
        const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({ conn, chat: chatKey, text: canonical, textSha256: hash, clientRequestId: id }),
        });
        const body: unknown = await res.json().catch(() => null);
        const a = classifyAnswer(res.status, body);
        if (a.kind === "refused" && (res.status === 401 || a.code === "mfa_required")) {
          setNote(res.status === 401 ? { text: SEND_ERROR_TEXT.no_session ?? "", href: "/sign-in", link: "Sign in" } : { text: SEND_ERROR_TEXT.mfa_required ?? "", href: "/mfa", link: "Enter your authenticator code" });
        }
        if (a.kind === "stepup") {
          // The server holds nothing (it stopped before proposing). The text stays in the box; the tab copy is saved first, and the person is sent to enter the code only if it really was saved.
          setItems((xs) => xs.filter((x) => x.id !== id));
          removeMarker(where);
          const saved = text.raw !== null && teamsDrafts.write(laneId, userId, `${conn}:${chatKey}`, { text: text.raw });
          if (!saved) {
            setNote({ text: "Your text could not be kept for the authenticator step, so you were not sent away. Copy it, then reload and enter your authenticator code." });
            say("Your text could not be kept; copy it first.");
          } else {
            setNote({ text: SEND_STEP_UP_TEXT });
            say(SEND_STEP_UP_TEXT);
            const back = hrefFor(laneId, chatKey, null, conn);
            router.push(`/mfa?reauth=1&next=${encodeURIComponent(back.length <= 480 ? back : `/${laneId}/messages`)}`);
          }
          return { clear: false };
        }
        return finish(a);
      } catch {
        return finish({ kind: "unknown", reason: SEND_NETWORK_TEXT }); // no answer: it may have gone; never a retry from here
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [where, laneId, conn, chatKey, userId, router, say, upsert, patch],
  );

  const press = useCallback(
    async (raw: string): Promise<Press> => {
      if (inFlight.current) return { clear: false }; // a double click or a held key is the same press
      if (sendTextProblem(raw) !== null) return { clear: false };
      inFlight.current = true; // claimed before the first await: a second press during the hashing is ignored
      setNote(null);
      const canonical = normalizeSendText(raw);
      const hash = await sendTextHash(canonical);
      // the id of this exact text: reused until a terminal outcome is confirmed
      const id = idFor.current?.text === canonical ? idFor.current.id : newRequestId();
      if (id === null || hash === null) {
        inFlight.current = false;
        setNote({ text: "This browser cannot prepare the message safely, so nothing was sent." });
        return { clear: false };
      }
      idFor.current = { text: canonical, id };
      setItems((xs) => xs.filter((x) => x.state !== "not_sent")); // an earlier refusal's bubble gives way to this attempt
      inFlight.current = false;
      return submit(canonical, id, hash, Date.now(), { raw });
    },
    [submit],
  );

  const checkAgain = useCallback(
    async (id: string) => {
      if (inFlight.current) return;
      const item = items.find((x) => x.id === id);
      if (!item) return;
      const hash = (await sendTextHash(item.text)) ?? "";
      if (hash === "") return;
      idFor.current = { text: item.text, id };
      await submit(item.text, id, hash, Date.now(), { raw: null });
    },
    [items, submit],
  );

  const discard = useCallback(
    (id: string) => {
      removeMarker(where);
      if (idFor.current?.id === id) idFor.current = null;
      patch(id, { closed: true, reason: SEND_DISCARDED_TEXT });
    },
    [where, patch],
  );

  const api = useMemo<SendApi>(() => ({ items, busy, press, checkAgain, discard, restore, note, setNote, announce }), [items, busy, press, checkAgain, discard, restore, note, announce]);
  return <SendCtx.Provider value={api}>{children}</SendCtx.Provider>;
}

// ---- matching the sent messages to the ones Teams returns (so the next read shows ONE bubble each, not two)
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
/**
 * Which local bubbles the conversation already shows from Teams (T-288 review C2), ONE TO ONE. A bubble the server gave a message id for is hidden when that very message is in the list. A bubble
 * with no id (Sent, checking; an unknown outcome that turned out sent) is matched by text, oldest first, and each Teams message hides at most ONE bubble: one of the person's own, not earlier than the press
 * (2 minutes of clock skew), with the same text, and not a message another bubble owns by id. Two sends of "ok" are two bubbles until two messages are in the list.
 */
export function hiddenItems(items: readonly Pick<SendItem, "id" | "text" | "at" | "state" | "messageId">[], shown: readonly MessageView[]): Set<string> {
  const hidden = new Set<string>();
  const owned = new Set(items.flatMap((i) => (i.messageId ? [i.messageId] : [])));
  for (const i of items) if ((i.state === "sent" || i.state === "checking") && i.messageId && shown.some((m) => m.id === i.messageId)) hidden.add(i.id);
  const used = new Set<string>();
  for (const i of items) {
    if (hidden.has(i.id) || i.messageId || (i.state !== "sent" && i.state !== "checking")) continue;
    const want = squash(i.text);
    const m = shown.find((x) => !used.has(x.id) && !owned.has(x.id) && x.mine && !x.deleted && !x.system && Date.parse(x.at) >= i.at - 120_000 && squash(nodesText(x.nodes)) === want);
    if (m) {
      used.add(m.id);
      hidden.add(i.id);
    }
  }
  return hidden;
}

const STATE_GLYPH: Record<SendState, string> = { sending: "…", sent: "✓", checking: "✓…", not_sent: "!", unknown: "?" };

/** The sent messages not yet shown by the conversation itself, newest last, inside the list. `shown`: the messages the conversation holds now. */
export function PendingBubbles({ shown }: { shown: readonly MessageView[] }) {
  const send = useSend();
  const end = useRef<HTMLLIElement>(null);
  const hidden = hiddenItems(send?.items ?? [], shown);
  const items = (send?.items ?? []).filter((i) => !hidden.has(i.id));
  // the newest sent message is what the person is looking at: keep it in view when one is added or changes state (inside the message list only: never the window, which would move a phone's page)
  const marker = items.map((i) => `${i.id}:${i.state}`).join(",");
  useEffect(() => {
    const scroller = end.current?.closest<HTMLElement>('[data-testid="conversation-scroll"]');
    if (marker !== "" && scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [marker]);
  if (!send) return null;
  return (
    <>
      {items.map((i) => (
        <li key={i.id} data-testid="send-item" data-state={i.state} data-closed={i.closed ? "true" : "false"} className="flex w-full min-w-0 flex-col items-end gap-0.5">
          <MessageBubble mine fullTime="">
            <div dir="auto" data-testid="send-text" className="min-w-0 whitespace-pre-wrap text-body [overflow-wrap:anywhere]">
              {i.text}
            </div>
          </MessageBubble>
          <p data-testid="send-state" className={cn("flex flex-wrap items-baseline justify-end gap-x-1 px-1 text-small", i.state === "not_sent" ? "font-medium text-alert-foreground" : "text-muted-foreground")}>
            <span aria-hidden>{STATE_GLYPH[i.state]}</span>
            <span>{SEND_STATE_TEXT[i.state]}</span>
            {(i.state === "not_sent" || i.state === "unknown") && i.reason ? <span>: {i.reason}</span> : null}
          </p>
          {i.state === "unknown" && !i.closed ? (
            <div className="flex gap-2 px-1" data-testid="send-actions">
              <Button type="button" variant="outline" size="sm" className="max-lg:min-h-11" aria-disabled={send.busy ? true : undefined} onClick={() => void send.checkAgain(i.id)} data-testid="send-check-again">
                {SEND_CHECK_AGAIN}
              </Button>
              <Button type="button" variant="outline" size="sm" className="max-lg:min-h-11" onClick={() => send.discard(i.id)} data-testid="send-discard">
                {SEND_DISCARD}
              </Button>
            </div>
          ) : null}
        </li>
      ))}
      {items.length > 0 ? <li ref={end} aria-hidden className="h-0" /> : null}
    </>
  );
}

const control = "min-h-11 w-full min-w-0 resize-none rounded-control border border-border bg-card px-3 py-2 text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring max-lg:text-base";
/** Lines the box may grow to before it scrolls inside: about 8 on a desktop, 5 on a phone; never more than a third of the pane. */
const MAX_LINES = { desktop: 8, phone: 5 } as const;

/**
 * The composer. `userId` is only a key part of the tab's draft (it never decides access); `account` is the sign-in address of the conversation's account (the line under the box).
 */
export function Composer({ laneId, conn, chatKey, account, userId }: { laneId: string; conn: string; chatKey: string; account: string; userId: string }) {
  const send = useSend();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const latest = useRef("");
  const box = useRef<HTMLTextAreaElement>(null);
  const draftId = `${conn}:${chatKey}`;
  const writer = useMemo(() => debounced((t: string) => (t === "" ? teamsDrafts.remove(laneId, userId, draftId) : void teamsDrafts.write(laneId, userId, draftId, { text: t })), 500), [laneId, userId, draftId]);
  // the text kept in this tab (a stale authenticator code, a reload): put back once when the composer opens, unless a send is on record for this chat (that one is shown as a bubble, not restored)
  useEffect(() => {
    const kept = teamsDrafts.read(laneId, userId, draftId);
    if (kept && readMarker({ laneId, userId, item: draftId }) === null) {
      latest.current = kept.text;
      setText((cur) => (cur === "" ? kept.text : cur)); // eslint-disable-line react-hooks/set-state-in-effect -- reads the tab's own storage once after mount (never during render)
    }
    return () => writer.flush();
  }, [laneId, userId, draftId, writer]);
  // a late "not sent" answer found on return: the text goes back into an EMPTY box
  const restoreN = send?.restore?.n ?? 0;
  useEffect(() => {
    const r = send?.restore;
    if (r && latest.current === "") {
      latest.current = r.text;
      setText(r.text);
    }
  }, [restoreN]); // eslint-disable-line react-hooks/exhaustive-deps -- `n` is the change signal; the text is read from the same render

  // the box grows with its text up to the line limit (and a third of the pane), then scrolls inside
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = window.getComputedStyle(el);
    const line = Number.parseFloat(cs.lineHeight) || 22;
    const pad = (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.paddingBottom) || 0) + (Number.parseFloat(cs.borderTopWidth) || 0) + (Number.parseFloat(cs.borderBottomWidth) || 0);
    const phone = typeof window.matchMedia === "function" ? !window.matchMedia("(min-width: 1024px)").matches : false;
    const pane = el.closest<HTMLElement>('[data-testid="conversation"]')?.clientHeight ?? 0;
    const byLines = (phone ? MAX_LINES.phone : MAX_LINES.desktop) * line + pad;
    const cap = pane > 0 ? Math.min(byLines, Math.max(pane / 3, 44)) : byLines;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    el.style.overflowY = el.scrollHeight > cap ? "auto" : "hidden";
  }, [text]);

  // one normalisation per change of the text, shared by the counter, the reason and the button
  const { problem, count } = useMemo(() => ({ problem: sendTextProblem(text), count: sendCharCount(text) }), [text]);
  const busy = send?.busy ?? false;
  const canSend = problem === null && !busy;

  function edit(v: string) {
    latest.current = v;
    setText(v);
    send?.setNote(null);
    writer.call(v);
  }
  async function go() {
    if (!send) return;
    const sent = text;
    const r = await send.press(sent);
    // the box is emptied only if it still holds exactly what was sent: text typed while the send was open stays, with its saved copy
    if (r.clear && latest.current === sent) {
      latest.current = "";
      setText("");
      writer.cancel();
      teamsDrafts.remove(laneId, userId, draftId);
    } // else something newer is in the box: it and its saved copy are left alone
    box.current?.focus();
  }
  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.nativeEvent.isComposing) return; // not while an input method is composing
    // desktop only: on a phone only the button sends (an accidental key must never be an approval)
    if (typeof window.matchMedia === "function" && !window.matchMedia("(min-width: 1024px)").matches) return;
    e.preventDefault();
    void go();
  }

  const note = send?.note ?? null;
  return (
    <form
      data-testid="composer"
      data-focused={focused ? "true" : "false"}
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
      className="group/composer flex min-w-0 flex-col gap-1 py-1"
    >
      <div className="flex min-w-0 items-end gap-2">
        <textarea
          ref={box}
          value={text}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          rows={1}
          aria-label="Message to send in Teams (plain text)"
          aria-describedby="composer-line composer-count"
          data-testid="composer-text"
          className={control}
        />
        {/* pointer-down is not allowed to move the focus: on a phone the keyboard must stay up (and the layout still) until the click lands */}
        <Button type="submit" aria-disabled={!canSend ? true : undefined} data-testid="composer-send" className="min-h-11 shrink-0" onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={(e) => !canSend && e.preventDefault()}>
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
      <p className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 text-small text-muted-foreground">
        {/* with the phone keyboard up the account line gives way (screen readers still have it) */}
        <span id="composer-line" data-testid="composer-line" className="min-w-0 [overflow-wrap:anywhere] group-data-[focused=true]/composer:max-lg:sr-only">
          {teamsSendLine(account)}
        </span>
        <span id="composer-count" data-testid="composer-count" className={cn("shrink-0", problem === "too_long" && "font-medium text-alert-foreground")}>
          {count.toLocaleString("en-US")} / {SEND_MAX_CHARS.toLocaleString("en-US")}
        </span>
      </p>
      <p data-testid="composer-hint" className="hidden text-small text-muted-foreground lg:block">
        {MESSAGES_SEND_HINT_DESKTOP}
      </p>
      <div role="status" aria-live="polite" data-testid="composer-problem-region">
        {problem !== null && problem !== "empty" ? (
          <p data-testid="composer-problem" className="text-small text-alert-foreground">
            {SEND_TEXT_PROBLEM[problem]}
          </p>
        ) : null}
      </div>
      {note ? (
        <p data-testid="composer-note" className="text-small font-medium text-foreground">
          {note.text}
          {note.href ? (
            <>
              {" "}
              <a href={note.href} className="underline underline-offset-2">
                {note.link}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      <span role="status" aria-live="polite" data-testid="composer-announce" className="sr-only">
        {send?.announce ?? ""}
      </span>
    </form>
  );
}
