// The Reply drawer's unsent edits, per message, in sessionStorage (T-234 part 3; part 5 generalises the autosave and reuses this).
// Survives a step-up redirect to /mfa and a reload; gone when the tab closes. Everything is in try/catch: private mode, a full
// quota or a blocked storage only mean the edits are not kept, never a broken page. Cleared after a successful send or save.
export type ReplyDraftFields = { to: string; cc: string; body: string };

const PREFIX = "nichols:reply-draft:";
const MAX_BODY = 100_000;
const key = (laneId: string, messageId: string) => `${PREFIX}${laneId}:${messageId}`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveReplyDraft(laneId: string, messageId: string, fields: ReplyDraftFields): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key(laneId, messageId), JSON.stringify({ v: 1, to: fields.to.slice(0, 5000), cc: fields.cc.slice(0, 5000), body: fields.body.slice(0, MAX_BODY) }));
    return true;
  } catch {
    return false;
  }
}

export function loadReplyDraft(laneId: string, messageId: string): ReplyDraftFields | null {
  try {
    const raw = storage()?.getItem(key(laneId, messageId));
    if (!raw) return null;
    const v = JSON.parse(raw) as { v?: unknown; to?: unknown; cc?: unknown; body?: unknown };
    if (v.v !== 1 || typeof v.to !== "string" || typeof v.cc !== "string" || typeof v.body !== "string") return null;
    return { to: v.to, cc: v.cc, body: v.body };
  } catch {
    return null;
  }
}

export function clearReplyDraft(laneId: string, messageId: string): void {
  try {
    storage()?.removeItem(key(laneId, messageId));
  } catch {
    // nothing to clear
  }
}
