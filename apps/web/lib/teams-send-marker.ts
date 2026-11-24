// The in-flight markers of Teams sends (T-288 review A, re-check 2), kept in THIS TAB's session storage, ONE RECORD PER MESSAGE: the request id, the hash of the canonical text, the text itself (for "Send if it
// has not been sent" and to copy), the start time and the last known state. A small list (at most MAX_MARKERS, the oldest dropped) per lane, person, connection and chat, so an unknown outcome for message X
// survives sending a different message Y and a reload. A marker is written synchronously BEFORE the request leaves and removed only when an answer is confirmed; the unsent-text copy (`teamsDrafts`) is
// removed when the marker is written and a draft whose text equals a marker's text is never restored (the text lives in the marker). Plain module, no directive. Only companies that store outbound drafts have
// a Teams composer, so this follows the lane policy.
import { draftNamespace } from "./reply-draft-store";

export type MarkerState = "inflight" | "unknown" | "sent" | "checking" | "not_sent";
export type SendMarker = { id: string; hash: string; text: string; startedAt: number; state: MarkerState; messageId: string | null; reason: string | null; dismissed: boolean };
export const MAX_MARKERS = 5;
/** A Teams action lives one hour (`act.expiry_hours`): past it the portal no longer offers to send again with the same id. */
export const MARKER_LIFETIME_MS = 3_600_000;

const STATES: readonly string[] = ["inflight", "unknown", "sent", "checking", "not_sent"];
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

function one(v: unknown): SendMarker | null {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  if (!o) return null;
  const id = str(o.id, 64);
  const hash = str(o.hash, 64);
  const text = str(o.text, 40_000);
  const state = str(o.state, 16);
  if (id === null || hash === null || text === null || state === null || !STATES.includes(state) || typeof o.startedAt !== "number") return null;
  return { id, hash, text, startedAt: o.startedAt, state: state as MarkerState, messageId: str(o.messageId, 256), reason: str(o.reason, 500), dismissed: o.dismissed === true };
}

const ns = draftNamespace<SendMarker[]>("teams-send", {
  ttlMs: 2 * 3_600_000,
  validate(v) {
    const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
    const list = Array.isArray(o?.list) ? (o?.list as unknown[]) : null;
    if (!list) return null;
    const out = list.flatMap((x) => {
      const m = one(x);
      return m ? [m] : [];
    });
    return out.length === 0 ? null : out.slice(-MAX_MARKERS);
  },
});
// the namespace stores `{ list }` (an object, so the validator can tell it from an older single record)
const write = (w: Where, list: SendMarker[]): boolean => (list.length === 0 ? (ns.remove(w.laneId, w.userId, w.item), true) : ns.write(w.laneId, w.userId, w.item, { list: list.slice(-MAX_MARKERS) } as unknown as SendMarker[]));

type Where = { laneId: string; userId: string; item: string };
const listeners = new Map<string, Set<(id: string, m: SendMarker | null) => void>>();
const keyOf = (w: Where) => `${w.laneId}:${w.userId}:${w.item}`;
const emit = (w: Where, id: string, m: SendMarker | null) => listeners.get(keyOf(w))?.forEach((f) => f(id, m));

export const readMarkers = (w: Where): SendMarker[] => ns.read(w.laneId, w.userId, w.item) ?? [];
/** Saves (or replaces, by id) one marker; the oldest beyond the cap are dropped. True when really saved. */
export function putMarker(w: Where, m: SendMarker): boolean {
  const rest = readMarkers(w).filter((x) => x.id !== m.id);
  const ok = write(w, [...rest, m]);
  emit(w, m.id, m);
  return ok;
}
export function removeMarker(w: Where, id: string): void {
  write(w, readMarkers(w).filter((x) => x.id !== id));
  emit(w, id, null);
}
/** A late answer for a send whose chat was left (the page is alive) updates the stored marker; a composer that is open for the same chat hears it. Returns the unsubscribe. */
export function subscribeMarkers(w: Where, fn: (id: string, m: SendMarker | null) => void): () => void {
  const k = keyOf(w);
  const set = listeners.get(k) ?? new Set();
  set.add(fn);
  listeners.set(k, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(k);
  };
}

/** The lane no longer allows sending (policy off, drafts not stored): this person's tab copies and markers for the lane go. A few lines of storage, nothing else. */
export function clearTeamsRecords(laneId: string, userId: string): void {
  try {
    const s = window.sessionStorage;
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k !== null && (k.startsWith(`nichols:teams-send:${laneId}:${userId}:`) || k.startsWith(`nichols:teams-draft:${laneId}:${userId}:`))) doomed.push(k);
    }
    for (const k of doomed) s.removeItem(k);
  } catch {
    // storage blocked: nothing to clear
  }
}
