"use client";
// Messages: the Send box (T-288; spec docs/specs/messages.md 10.3, 10.5, 22.8; decision D-67; review fixes). The composer belongs to the conversation opened through `conn` (one account) and sends
// through THAT connection only; the line under it names the account. Pressing Send is the person's approval of the exact text: the browser hashes the text it shows and the route proposes, approves and
// sends it in one request (one POST at Microsoft).
// THE ONE RULE FOR THE REQUEST ID: the id belongs to the exact text of one intended message, not to one press. It is made at the first press for a text and KEPT for that text until the server has confirmed
// a terminal outcome (sent, checking, or a definite not-sent from an action that was proposed). Every later press with unchanged text reuses it, so the server (one action per connection + id) can never post twice.
// ONE RECORD PER MESSAGE (lib/teams-send-marker.ts): the in-flight marker holds the id, the hash, the text, the time and the state, in this tab's session storage, written before the request leaves and removed
// when an answer is confirmed; the unsent-text copy is removed when it is written and never restored when its text has a marker. A person who left the chat, reloaded or closed the tab mid-send finds the
// message again as "may have been sent" with "Send if it has not been sent" (the SAME id and text: the portal sends it at most once) and "Dismiss"; the text is never put back in the box. Several markers
// can exist (an unknown outcome for X survives sending Y).
// "NOT SENT" IS SAID ONLY WHEN NOTHING WAS SENT: for the route's own JSON refusals with a known code, and only for a FIRST submit of an id. A refusal answered to a REPLAY of an id that may already have
// posted (429, a gate, a stale code, reconnect, 503) says only that THIS request sent nothing: the message stays "may have been sent" with a note. A refusal that the route marks `fresh` (its proposal was
// rejected on the spot) and a result `failed` from the server are definite either way. Any other answer (a 5xx that is not the route's own JSON 503, a body that is not JSON, a dropped connection) is unknown.
//   SendScope       the engine and the bubbles of this conversation's sends, shared by the composer and the message list
//   PendingBubbles  those bubbles, each with its state as TEXT (never colour alone); a Sent bubble is hidden once the conversation shows that very message (by id, else one to one by text)
//   Composer        the text box, counter, Send button and the line under it
// No ref is read and no clock is called while rendering (react-hooks/refs, react-hooks/purity): time and ids are made in event handlers and effects.
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, cn } from "@nichols/ui";
import { hrefFor } from "@/lib/messages-href";
import { debounced, noteSignedInUser, teamsDrafts } from "@/lib/reply-draft-store";
import { clearTeamsRecords, MARKER_LIFETIME_MS, putMarker, readMarkers, removeMarker, subscribeMarkers, type SendMarker } from "@/lib/teams-send-marker";
import { newRequestId, normalizeSendText, SEND_MAX_CHARS, sendCharCount, sendTextHash, sendTextProblem } from "@/lib/teams-send-text";
import type { MessageView } from "@/lib/teams-chats";
import { MESSAGES_SEND_HINT_DESKTOP, SEND_DISMISS, SEND_DISMISSED_TEXT, SEND_ERROR_TEXT, SEND_IF_NOT_SENT, SEND_NETWORK_TEXT, SEND_REPLAY_NOTE, SEND_STALE_TEXT, SEND_STATE_TEXT, SEND_STEP_UP_TEXT, SEND_TEXT_PROBLEM, teamsSendLine, type SendState } from "@/lib/teams-wording";
import { useMessagesLive } from "./messages-live";
import { MessageBubble } from "./messages-bubble";

export type SendItem = {
  /** The request id of this composed message (also the React key). */
  id: string;
  /** What was sent (the person's own text, in this tab's memory and its session storage only). */
  text: string;
  state: SendState;
  /** A fixed sentence after "Not sent" (never text from Teams or the message). */
  reason: string | null;
  /** One optional note under the state line of an unknown outcome (never a second copy of the state line). */
  note: string | null;
  /** When the message was first pressed (ms), for matching the message Teams returns and for the action's one-hour life. Made in an event handler or effect. */
  at: number;
  /** The Graph id of the message when the server confirmed it (`sent`). */
  messageId: string | null;
  /** The person dismissed the check of an unknown outcome. */
  closed: boolean;
  /** Older than the action's own life (one hour): the portal no longer offers to send it again with the same id. */
  stale: boolean;
};

type Answer =
  | { kind: "sent"; messageId: string | null }
  | { kind: "checking" }
  | { kind: "not_sent"; reason: string }
  | { kind: "refused"; code: string; reason: string; fresh: boolean }
  | { kind: "stepup"; fresh: boolean }
  | { kind: "unknown"; reason: string | null };

/** What an answer from the route means, by the rule in the header: only the route's own JSON with a known code is a refusal. */
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
  if (code === "step_up_required" && status === 403) return { kind: "stepup", fresh: b.fresh === true };
  if (code === "unknown_outcome") return { kind: "unknown", reason: null };
  const known = code !== "" && Object.prototype.hasOwnProperty.call(SEND_ERROR_TEXT, code);
  // `unavailable` is the route's own 503 (a read failed before anything was proposed); a 5xx with any other body is the platform's or an unclassified failure after the entry started
  if (!known || (status >= 500 && !(code === "unavailable" && status === 503))) return { kind: "unknown", reason: null };
  // `request_reused` says this id exists with other content: this text was not sent under it, and the next press needs a new id
  return { kind: "refused", code, reason: SEND_ERROR_TEXT[code] ?? "", fresh: b.fresh === true || code === "request_reused" };
}

type Press = { clear: boolean };
type Note = { text: string; href?: string; link?: string } | null;
type SendApi = {
  items: readonly SendItem[];
  busy: boolean;
  /** Sends the (raw) text. `clear`: the box may be emptied (if it still holds exactly this text). */
  press(raw: string): Promise<Press>;
  /** Asks the server again about a message that may have been sent, with the SAME id and text: it is sent now only if it never was. */
  sendIfNotSent(id: string): Promise<void>;
  dismiss(id: string): void;
  /** Text to put back into an empty box (a late definite "not sent" answer found on return). */
  restore: { text: string; n: number } | null;
  note: Note;
  setNote(n: Note): void;
  announce: string;
};
const SendCtx = createContext<SendApi | null>(null);
const useSend = (): SendApi | null => useContext(SendCtx);

/** The text of the live region after announcing `s`: the same words twice in a row get a zero-width mark toggled on, so the text node changes and a screen reader says them again. */
export const nextAnnounce = (prev: string, s: string): string => (prev.replaceAll("\u200b", "") === s ? (prev.endsWith("\u200b") ? s : `${s}\u200b`) : s);

type ScopeProps = { laneId: string; conn: string; chatKey: string; userId: string; enabled: boolean; /** Sending is switched off for this company: this person's tab copies and markers for the lane are removed. */ clear?: boolean; children: ReactNode };

export function SendScope({ laneId, conn, chatKey, userId, enabled, clear = false, children }: ScopeProps) {
  const router = useRouter();
  const live = useMessagesLive();
  const [items, setItems] = useState<readonly SendItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [restore, setRestore] = useState<{ text: string; n: number } | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [announce, setAnnounce] = useState("");
  const inFlight = useRef(false);
  const idFor = useRef<{ text: string; id: string } | null>(null); // the id of the text being composed after a definite refusal of a first submit (no marker then)
  const inDoubt = useRef(new Set<string>()); // ids whose request has left and whose outcome is not confirmed: a refusal for them is never "Not sent"
  const alive = useRef(true);
  const where = useMemo(() => ({ laneId, userId, item: `${conn}:${chatKey}` }), [laneId, userId, conn, chatKey]);
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  });

  const say = useCallback((s: string) => setAnnounce((prev) => nextAnnounce(prev, s)), []);
  const upsert = useCallback((item: SendItem) => setItems((xs) => (xs.some((x) => x.id === item.id) ? xs.map((x) => (x.id === item.id ? item : x)) : [...xs, item])), []);
  const patch = useCallback((id: string, p: Partial<SendItem>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x))), []);

  // Records from before (another visit, a reload, a closed tab) or a late answer for a chat that was left: shown, never put back into the box (except a confirmed "not sent").
  useEffect(() => {
    alive.current = true;
    if (clear) clearTeamsRecords(laneId, userId); // sending is off for this company: nothing about it is kept in this tab
    if (!enabled) return undefined;
    noteSignedInUser(userId); // another person signing in in this tab clears the previous person's tab copies before anything is read
    const adopt = (m: SendMarker) => {
      const stale = Date.now() - m.startedAt > MARKER_LIFETIME_MS;
      const base: SendItem = { id: m.id, text: m.text, state: "unknown", reason: null, note: m.dismissed ? SEND_DISMISSED_TEXT : stale ? SEND_STALE_TEXT : null, at: m.startedAt, messageId: null, closed: m.dismissed, stale };
      if (m.state === "sent" || m.state === "checking") {
        upsert({ ...base, state: m.state, note: null, closed: false, messageId: m.messageId });
        inDoubt.current.delete(m.id);
        removeMarker(where, m.id);
      } else if (m.state === "not_sent") {
        upsert({ ...base, state: "not_sent", reason: m.reason, note: null, closed: false });
        inDoubt.current.delete(m.id);
        removeMarker(where, m.id);
        setRestore((r) => ({ text: m.text, n: (r?.n ?? 0) + 1 }));
      } else {
        upsert(base);
        inDoubt.current.add(m.id);
      }
    };
    for (const m of readMarkers(where)) adopt(m);
    const off = subscribeMarkers(where, (_id, m) => {
      if (m && !inFlight.current) adopt(m);
    });
    return () => {
      alive.current = false;
      off();
    };
  }, [enabled, clear, laneId, userId, where, upsert]);

  // one request for (text, id, hash): the marker first, then the request, then what the answer means
  const submit = useCallback(
    async (canonical: string, id: string, hash: string, now: number, text: { raw: string | null }): Promise<Press> => {
      inFlight.current = true;
      setBusy(true);
      const prior = readMarkers(where).find((x) => x.id === id);
      // a REPLAY: this id was submitted before (a marker exists for it, or an earlier request of this page whose outcome was not confirmed). Its refusals mean only "this request sent nothing".
      const replay = prior !== undefined || inDoubt.current.has(id);
      const startedAt = prior?.startedAt ?? now;
      const marker: SendMarker = { id, hash, text: canonical, startedAt, state: "inflight", messageId: null, reason: null, dismissed: false };
      putMarker(where, marker); // synchronously, before the request leaves
      teamsDrafts.remove(laneId, userId, where.item); // the text lives in the marker now: never restored as a draft
      inDoubt.current.add(id);
      upsert({ id, text: canonical, state: "sending", reason: null, note: null, at: startedAt, messageId: null, closed: false, stale: false });
      say(SEND_STATE_TEXT.sending);
      const settle = (state: SendState, reason: string | null, messageId: string | null, markerState: SendMarker["state"] | null) => {
        patch(id, { state, reason, note: null, messageId, closed: false });
        say(state === "not_sent" ? `${SEND_STATE_TEXT.not_sent}${reason ? `: ${reason}` : ""}` : SEND_STATE_TEXT[state]);
        inDoubt.current.delete(id);
        if (markerState === null || alive.current) removeMarker(where, id);
        else putMarker(where, { ...marker, state: markerState, messageId, reason }); // a late answer after the chat was left: the right state shows on return
      };
      const stillUnknown = (noteText: string | null) => {
        patch(id, { state: "unknown", reason: null, note: noteText, messageId: null, closed: false });
        say(SEND_STATE_TEXT.unknown);
        putMarker(where, { ...marker, state: "unknown" }); // kept: on return, or for "Send if it has not been sent", the bubble is rebuilt from it
      };
      const finish = (a: Answer): Press => {
        if (a.kind === "sent" || a.kind === "checking") {
          const state = a.kind === "sent" ? "sent" : "checking";
          const messageId = a.kind === "sent" ? a.messageId : null;
          settle(state, null, messageId, state);
          idFor.current = null;
          if (a.kind === "sent") liveRef.current?.requestRefresh("refresh"); // one re-read; at most once a minute, a refusal is fine
          return { clear: true };
        }
        if (a.kind === "unknown") {
          stillUnknown(a.reason ?? null);
          return { clear: true };
        }
        if (a.kind === "not_sent") {
          // the server says the action itself ended without sending: terminal for every request, replay or not
          settle("not_sent", a.reason, null, "not_sent");
          idFor.current = null;
          return { clear: false };
        }
        if (a.kind === "refused") {
          if (!replay || a.fresh) {
            // nothing was sent: a first submit refused before anything was proposed, or a proposal the server rejected on the spot (definite even for a replay: it was never approved)
            settle("not_sent", a.reason, null, "not_sent");
            if (a.fresh) idFor.current = null; // a replay would find the rejected action: the next press needs a new id; otherwise the SAME id is kept for the same text
            else idFor.current = { text: canonical, id };
            return { clear: false };
          }
          // a replay: this request sent nothing, but an earlier one with the same id may have: the message stays "may have been sent"
          stillUnknown(SEND_REPLAY_NOTE[a.code === "rate_limited" ? "rate_limited" : a.code === "reconnect" ? "reconnect" : a.code === "mfa_required" ? "mfa_required" : a.code === "no_session" ? "no_session" : "default"] ?? SEND_REPLAY_NOTE.default ?? "");
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
          const goToCode = () => {
            const back = hrefFor(laneId, chatKey, null, conn);
            router.push(`/mfa?reauth=1&next=${encodeURIComponent(back.length <= 480 ? back : `/${laneId}/messages`)}`);
          };
          if (replay && !a.fresh) {
            // a replay: the bubble and the marker stay (the text is in the marker, so there is nothing to save); the person goes to enter the code and comes back to the same bubble and its action
            stillUnknown(SEND_REPLAY_NOTE.step_up_required ?? null);
            setNote({ text: SEND_STEP_UP_TEXT });
            goToCode();
            return { clear: false };
          }
          // a first submit (or a proposal rejected on the spot): the server holds nothing. The text stays in the box; the tab copy is saved first, and the person is sent to enter the code only if it really was saved.
          setItems((xs) => xs.filter((x) => x.id !== id));
          removeMarker(where, id);
          inDoubt.current.delete(id);
          if (a.fresh) idFor.current = null;
          else idFor.current = { text: canonical, id };
          const saved = text.raw !== null && teamsDrafts.write(laneId, userId, where.item, { text: text.raw });
          if (!saved) {
            setNote({ text: "Your text could not be kept for the authenticator step, so you were not sent away. Copy it, then reload and enter your authenticator code." });
            say("Your text could not be kept; copy it first.");
          } else {
            setNote({ text: SEND_STEP_UP_TEXT });
            say(SEND_STEP_UP_TEXT);
            goToCode();
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
      // the id of this exact text: a marker for it (unknown, dismissed) within the action's life, else the id of a refused first submit, else a new one
      const known = readMarkers(where).find((m) => m.text === canonical && Date.now() - m.startedAt <= MARKER_LIFETIME_MS);
      const id = known?.id ?? (idFor.current?.text === canonical ? idFor.current.id : newRequestId());
      if (id === null || hash === null) {
        inFlight.current = false;
        setNote({ text: "This browser cannot prepare the message safely, so nothing was sent." });
        return { clear: false };
      }
      setItems((xs) => xs.filter((x) => x.state !== "not_sent")); // an earlier refusal's bubble gives way to this attempt
      inFlight.current = false;
      return submit(canonical, id, hash, Date.now(), { raw });
    },
    [submit, where],
  );

  const sendIfNotSent = useCallback(
    async (id: string) => {
      if (inFlight.current) return;
      const item = items.find((x) => x.id === id);
      if (!item) return;
      if (Date.now() - item.at > MARKER_LIFETIME_MS) {
        patch(id, { stale: true, note: SEND_STALE_TEXT }); // past the action's own life: not offered any more (a retyped text gets a new id)
        return;
      }
      const hash = (await sendTextHash(item.text)) ?? "";
      if (hash === "") return;
      await submit(item.text, id, hash, Date.now(), { raw: null });
    },
    [items, submit, patch],
  );

  const dismiss = useCallback(
    (id: string) => {
      // the id is kept for that exact text (the marker stays, flagged): retyping it asks about the same message first, so it can never be posted twice
      const m = readMarkers(where).find((x) => x.id === id);
      if (m) putMarker(where, { ...m, dismissed: true });
      patch(id, { closed: true, note: SEND_DISMISSED_TEXT });
    },
    [where, patch],
  );

  const api = useMemo<SendApi>(() => ({ items, busy, press, sendIfNotSent, dismiss, restore, note, setNote, announce }), [items, busy, press, sendIfNotSent, dismiss, restore, note, announce]);
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
            {/* ONE state line; a message too old to ask the server about says so in its place (never both) */}
            <span>{i.state === "unknown" && i.stale ? SEND_STALE_TEXT : SEND_STATE_TEXT[i.state]}</span>
            {i.state === "not_sent" && i.reason ? <span>: {i.reason}</span> : null}
          </p>
          {i.state === "unknown" && i.note && !(i.stale && i.note === SEND_STALE_TEXT) ? (
            <p data-testid="send-note" className="px-1 text-small text-muted-foreground">
              {i.note}
            </p>
          ) : null}
          {i.state === "unknown" && !i.closed ? (
            <div className="flex gap-2 px-1" data-testid="send-actions">
              {i.stale ? null : (
                <Button type="button" variant="outline" size="sm" className="max-lg:min-h-11" aria-disabled={send.busy ? true : undefined} onClick={() => void send.sendIfNotSent(i.id)} data-testid="send-if-not-sent">
                  {SEND_IF_NOT_SENT}
                </Button>
              )}
              <Button type="button" variant="outline" size="sm" className="max-lg:min-h-11" onClick={() => send.dismiss(i.id)} data-testid="send-dismiss">
                {SEND_DISMISS}
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
export function Composer({ laneId, conn, chatKey, account, accountLabel = null, userId }: { laneId: string; conn: string; chatKey: string; account: string; /** The short label of the account when the person has more than one (it stays visible while the phone keyboard is up). */ accountLabel?: string | null; userId: string }) {
  const send = useSend();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const latest = useRef("");
  const box = useRef<HTMLTextAreaElement>(null);
  const draftId = `${conn}:${chatKey}`;
  const writer = useMemo(() => debounced((t: string) => (t === "" ? teamsDrafts.remove(laneId, userId, draftId) : void teamsDrafts.write(laneId, userId, draftId, { text: t })), 500), [laneId, userId, draftId]);
  // the text kept in this tab (a stale authenticator code, a reload): put back once when the composer opens, unless that very text has a send on record (the marker shows it as a bubble; one record per message)
  useEffect(() => {
    const kept = teamsDrafts.read(laneId, userId, draftId);
    if (kept && !readMarkers({ laneId, userId, item: draftId }).some((m) => m.text === normalizeSendText(kept.text))) {
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

  // the box grows with its text up to the line limit (and a third of the pane), then scrolls inside. It is fitted again when the pane's height changes (the phone keyboard opening), not only on a keystroke,
  // and when the list was at the bottom it stays at the bottom, so the newest message stays visible.
  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const scroller = el.closest<HTMLElement>('[data-testid="conversation"]')?.querySelector<HTMLElement>('[data-testid="conversation-scroll"]') ?? null;
    const atBottom = scroller !== null && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
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
    if (scroller && atBottom) scroller.scrollTop = scroller.scrollHeight;
  }, []);
  useLayoutEffect(() => {
    fit();
  }, [text, fit]);
  useEffect(() => {
    const pane = box.current?.closest<HTMLElement>('[data-testid="conversation"]');
    if (!pane || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => fit());
    ro.observe(pane);
    return () => ro.disconnect();
  }, [fit]);

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
    writer.cancel(); // the text lives in the send's own record now (one record per message)
    const r = await send.press(sent);
    // the box is emptied only if it still holds exactly what was sent: text typed while the send was open stays, with its saved copy
    if (r.clear && latest.current === sent) {
      latest.current = "";
      setText("");
      writer.cancel();
      teamsDrafts.remove(laneId, userId, draftId);
    } else if (latest.current !== "") writer.call(latest.current); // what is in the box (a refused text, or something newer) is kept in the tab again
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
        {/* with more than one account the short label stays visible while typing on a phone: which account this posts as is never hidden */}
        {accountLabel ? (
          <span aria-hidden data-testid="composer-line-short" className="hidden min-w-0 max-w-[16ch] truncate group-data-[focused=true]/composer:max-lg:inline">
            As {accountLabel}
          </span>
        ) : null}
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
