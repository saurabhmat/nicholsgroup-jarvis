// The browser's side of the Messages notices (T-290, spec 9.4). Plain functions over `fetch` to THIS portal's own route (`/api/lanes/<lane>/messages/activity`: one database row, never
// Microsoft) and a tiny shared store for the navigation dot, so the side menu, the iPhone More list and the Messages page all show one answer and ask the server once. No directive: it holds no
// component. No timer lives here: the only loop is in components/messages-live.tsx, with a comment that says why it is allowed.
import { DOT_MIN_GAP_MS } from "./messages-live-config";

export type ActivityAnswer = { live: boolean; liveUntil: string | null; dot: boolean; lastNoticeAt: string | null; /** The server's clock when it answered (null from an older server): only to compare with `lastNoticeAt`. */ serverNow: string | null };

function parse(v: unknown): ActivityAnswer | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const at = (x: unknown) => (typeof x === "string" && !Number.isNaN(Date.parse(x)) ? x : null);
  return { live: r.live === true, liveUntil: at(r.liveUntil), dot: r.dot === true, lastNoticeAt: at(r.lastNoticeAt), serverNow: at(r.serverNow) };
}

/** The state from the portal's own database, or why not: the HTTP status of a refusal (null: the request itself failed). */
export async function askActivity(laneId: string, signal?: AbortSignal): Promise<{ ok: true; answer: ActivityAnswer } | { ok: false; status: number | null }> {
  try {
    const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/activity`, { credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}) });
    if (!res.ok) return { ok: false, status: res.status };
    const answer = parse(await res.json());
    return answer ? { ok: true, answer } : { ok: false, status: null };
  } catch {
    return { ok: false, status: null };
  }
}

/** The state from the portal's own database. Null on any failure (never a guess): the caller keeps what it knew. */
export async function getActivity(laneId: string, signal?: AbortSignal): Promise<ActivityAnswer | null> {
  const r = await askActivity(laneId, signal);
  return r.ok ? r.answer : null;
}

/** The person opened the chat list: records it and returns the state as it is now. */
export async function postSeen(laneId: string, signal?: AbortSignal): Promise<ActivityAnswer | null> {
  try {
    const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/messages/activity`, { method: "POST", credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}) });
    return res.ok ? parse(await res.json()) : null;
  } catch {
    return null;
  }
}

// ---- the dot: one value per lane, shared by every place that draws it
type Listener = () => void;
type Slot = { dot: boolean; lastAt: number | null; inflight: boolean; listeners: Set<Listener> };
const slots = new Map<string, Slot>();
const slotFor = (laneId: string): Slot => {
  let s = slots.get(laneId);
  if (!s) slots.set(laneId, (s = { dot: false, lastAt: null, inflight: false, listeners: new Set() }));
  return s;
};

export function subscribeDot(laneId: string, listener: Listener): () => void {
  const s = slotFor(laneId);
  s.listeners.add(listener);
  return () => void s.listeners.delete(listener);
}
export const dotSnapshot = (laneId: string): boolean => slotFor(laneId).dot;

/** Records an answer from anywhere (the Messages page's own poll, a seen mark): everything that draws the dot follows. */
export function publishDot(laneId: string, dot: boolean, at: number = Date.now()): void {
  const s = slotFor(laneId);
  s.lastAt = at;
  if (s.dot === dot) return;
  s.dot = dot;
  for (const l of [...s.listeners]) l();
}

/**
 * Asks the database for the dot, from the shell after it rendered. At most one request in flight and at most one per DOT_MIN_GAP_MS (a page change or the tab coming back); never a timer.
 * `now` is a parameter so a test needs no clock.
 */
export async function refreshDot(laneId: string, now: number = Date.now()): Promise<void> {
  const s = slotFor(laneId);
  if (s.inflight || (s.lastAt !== null && now - s.lastAt < DOT_MIN_GAP_MS)) return;
  s.inflight = true;
  try {
    const a = await getActivity(laneId);
    if (a) publishDot(laneId, a.dot, now);
  } finally {
    s.inflight = false;
  }
}

/** Test helper. */
export function resetDotForTests(): void {
  slots.clear();
}
