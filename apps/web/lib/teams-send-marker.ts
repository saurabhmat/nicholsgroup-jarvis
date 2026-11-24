// The in-flight marker of a Teams send (T-288 review A), kept in THIS TAB's session storage next to the unsent-text copy (lib/reply-draft-store.ts), per lane, person, connection and chat. It is written
// synchronously BEFORE the request leaves and removed only when an answer has been confirmed, so a person who leaves the chat, reloads or closes the tab mid-send finds the message again as "may have been sent"
// (never silently put back into the box, which would invite a second send). It holds the request id, the hash of the canonical text, the text (for "Check again" and to copy), the start time and the last known
// state. Plain module, no directive: client code only touches it. Only companies that store outbound drafts have a Teams composer, so this follows the lane policy.
import { draftNamespace } from "./reply-draft-store";

export type MarkerState = "inflight" | "unknown" | "sent" | "checking" | "not_sent";
export type SendMarker = { id: string; hash: string; text: string; startedAt: number; state: MarkerState; messageId: string | null; reason: string | null };

const STATES: readonly string[] = ["inflight", "unknown", "sent", "checking", "not_sent"];
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

const ns = draftNamespace<SendMarker>("teams-send", {
  ttlMs: 2 * 3_600_000,
  validate(v) {
    const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
    if (!o) return null;
    const id = str(o.id, 64);
    const hash = str(o.hash, 64);
    const text = str(o.text, 40_000);
    const state = str(o.state, 16);
    if (id === null || hash === null || text === null || state === null || !STATES.includes(state) || typeof o.startedAt !== "number") return null;
    return { id, hash, text, startedAt: o.startedAt, state: state as MarkerState, messageId: str(o.messageId, 256), reason: str(o.reason, 500) };
  },
});

type Where = { laneId: string; userId: string; item: string };
const listeners = new Map<string, Set<(m: SendMarker | null) => void>>();
const keyOf = (w: Where) => `${w.laneId}:${w.userId}:${w.item}`;
const emit = (w: Where, m: SendMarker | null) => listeners.get(keyOf(w))?.forEach((f) => f(m));

export const readMarker = (w: Where): SendMarker | null => ns.read(w.laneId, w.userId, w.item);
/** True when the marker was really saved. */
export function writeMarker(w: Where, m: SendMarker): boolean {
  const ok = ns.write(w.laneId, w.userId, w.item, m);
  emit(w, m);
  return ok;
}
export function removeMarker(w: Where): void {
  ns.remove(w.laneId, w.userId, w.item);
  emit(w, null);
}
/** A late answer for a send whose chat was left (the page is alive) updates the stored marker; a composer that is open for the same chat hears it. Returns the unsubscribe. */
export function subscribeMarker(w: Where, fn: (m: SendMarker | null) => void): () => void {
  const k = keyOf(w);
  const set = listeners.get(k) ?? new Set();
  set.add(fn);
  listeners.set(k, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(k);
  };
}
