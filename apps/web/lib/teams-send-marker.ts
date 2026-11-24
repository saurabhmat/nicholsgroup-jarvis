// The in-flight markers of Teams sends (T-288 review A, re-check 2), kept in THIS TAB's session storage, ONE RECORD PER MESSAGE: the request id, the hash of the canonical text, the text itself (for "Send if it
// has not been sent" and to copy), the start time and the last known state. A small list (at most MAX_MARKERS, the oldest dropped) per lane, person, connection and chat, so an unknown outcome for message X
// survives sending a different message Y and a reload. A marker is written synchronously BEFORE the request leaves and removed only when an answer is confirmed; the unsent-text copy (`teamsDrafts`) is
// removed when the marker is written and a draft whose text equals a marker's text is never restored (the text lives in the marker). Plain module, no directive. Only companies that store outbound drafts have
// a Teams composer, so this follows the lane policy.
import { draftNamespace } from "./reply-draft-store";

export type MarkerState = "inflight" | "unknown" | "sent" | "checking" | "not_sent";
export type SendMarker = { id: string; hash: string; text: string; startedAt: number; state: MarkerState; messageId: string | null; reason: string | null; dismissed: boolean };
export const MAX_MARKERS = 5;
/** A record is never evicted while its outcome is unresolved: this many unresolved (in flight or unknown, not dismissed) records for one chat stop a new send until the person has looked at them. */
export const unresolvedOf = (list: readonly SendMarker[]): SendMarker[] => list.filter((m) => !m.dismissed && (m.state === "inflight" || m.state === "unknown"));

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
/**
 * Saves (or replaces, by id) one marker. True when really saved. Over the cap the oldest RESOLVED or DISMISSED record goes first; an unresolved one is evicted only if nothing else can be
 * (the composer never lets that happen: it refuses a sixth unresolved message).
 */
export function putMarker(w: Where, m: SendMarker): boolean {
  let rest = readMarkers(w).filter((x) => x.id !== m.id);
  while (rest.length >= MAX_MARKERS) {
    const i = rest.findIndex((x) => !(x.state === "inflight" || x.state === "unknown") || x.dismissed);
    rest = rest.filter((_, k) => k !== (i >= 0 ? i : 0));
  }
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

/**
 * Sending is switched off for the company: this person's unsent-text copies for the lane go, and so do the records of messages whose outcome is known. The records of messages whose outcome is UNKNOWN,
 * in flight or dismissed stay (a real warning is not wiped, and a retyped text is still matched to its id): with `stripText` (the lane does not allow storing unsent text) their text is removed and only the id, the
 * text's hash, the time and the state are kept.
 */
export function clearTeamsRecords(laneId: string, userId: string, opts: { stripText: boolean }): void {
  try {
    const s = window.sessionStorage;
    const sendPrefix = `nichols:teams-send:${laneId}:${userId}:`;
    const draftPrefix = `nichols:teams-draft:${laneId}:${userId}:`;
    const drafts: string[] = [];
    const sends: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k === null) continue;
      if (k.startsWith(draftPrefix)) drafts.push(k);
      else if (k.startsWith(sendPrefix)) sends.push(k);
    }
    for (const k of drafts) s.removeItem(k);
    for (const k of sends) {
      const w = { laneId, userId, item: k.slice(sendPrefix.length) };
      const keep = readMarkers(w).filter((m) => m.state === "inflight" || m.state === "unknown" || m.dismissed).map((m) => (opts.stripText ? { ...m, text: "" } : m));
      write(w, keep);
    }
  } catch {
    // storage blocked: nothing to clear
  }
}
