// Unsent drafts in sessionStorage (T-234 part 3 review fixes; part 5 reuses `draftNamespace` for other drafts).
// Rules:
//   * Everything is in try/catch: private mode, a full quota or a blocked storage only mean nothing is kept, never a broken page.
//   * Keys carry lane + user + item id, so one person's draft is never offered to another person on a shared tab. The user id
//     comes from the server's context and is only a key part: it never decides access.
//   * Every entry has a time to live; an expired one is removed when read.
//   * Nothing is written when the lane does not store outbound drafts (D-19, rule 6): callers check `storesDrafts` first.
//   * The view-state namespaces (home-open, drawer-open) hold ids and flags only, never message content; drawer-open is written
//     only when the lane stores drafts (the drawer does it after its context loads).
//   * `noteSignedInUser()` clears every namespace when this tab sees a different user than last time (a sign-out that did not run).
//   * `clearAllDrafts()` runs at sign-out and removes every namespace listed in DRAFT_NAMESPACES.
export const DRAFT_NAMESPACES = ["reply-draft", "reply-ai", "home-open", "drawer-open"] as const;
export type DraftNamespaceName = (typeof DRAFT_NAMESPACES)[number];

const ROOT = "nichols:";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export type DraftNamespace<T> = {
  key: (laneId: string, userId: string, itemId: string) => string;
  write: (laneId: string, userId: string, itemId: string, value: T) => boolean;
  read: (laneId: string, userId: string, itemId: string) => T | null;
  remove: (laneId: string, userId: string, itemId: string) => void;
  clear: () => void;
};

/** A typed, expiring namespace. `validate` returns the clean value or null (anything else in storage is ignored). */
export function draftNamespace<T>(name: string, opts: { ttlMs: number; validate: (v: unknown) => T | null; now?: () => number }): DraftNamespace<T> {
  const prefix = `${ROOT}${name}:`;
  const now = opts.now ?? Date.now;
  const key = (laneId: string, userId: string, itemId: string) => `${prefix}${laneId}:${userId}:${itemId}`;
  return {
    key,
    write(laneId, userId, itemId, value) {
      try {
        const s = storage();
        if (!s) return false;
        s.setItem(key(laneId, userId, itemId), JSON.stringify({ v: 1, t: now(), d: value }));
        return true;
      } catch {
        return false;
      }
    },
    read(laneId, userId, itemId) {
      try {
        const s = storage();
        const k = key(laneId, userId, itemId);
        const raw = s?.getItem(k);
        if (!s || !raw) return null;
        const e = JSON.parse(raw) as { v?: unknown; t?: unknown; d?: unknown };
        if (e.v !== 1 || typeof e.t !== "number" || now() - e.t > opts.ttlMs || e.t > now() + 60_000) {
          s.removeItem(k);
          return null;
        }
        const clean = opts.validate(e.d);
        if (clean === null) s.removeItem(k);
        return clean;
      } catch {
        return null;
      }
    },
    remove(laneId, userId, itemId) {
      try {
        storage()?.removeItem(key(laneId, userId, itemId));
      } catch {
        // nothing to remove
      }
    },
    clear() {
      clearPrefix(prefix);
    },
  };
}

function clearPrefix(prefix: string): void {
  try {
    const s = storage();
    if (!s) return;
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k !== null && k.startsWith(prefix)) doomed.push(k);
    }
    for (const k of doomed) s.removeItem(k);
  } catch {
    // nothing to clear
  }
}

/** Sign-out: every draft of every namespace goes (the next person on this tab must not see them). */
export function clearAllDrafts(): void {
  for (const n of DRAFT_NAMESPACES) clearPrefix(`${ROOT}${n}:`);
}

const LAST_USER_KEY = `${ROOT}last-user`;

/** A different verified user than the one this tab last showed Home to: every draft namespace goes (an id is the only thing kept). */
export function noteSignedInUser(userId: string): void {
  try {
    const s = storage();
    if (!s) return;
    const last = s.getItem(LAST_USER_KEY);
    if (last !== null && last !== userId) clearAllDrafts();
    s.setItem(LAST_USER_KEY, userId);
  } catch {
    // storage blocked: nothing is kept anyway
  }
}

/** A trailing-edge debounce with flush and cancel (the drawer writes 500 ms after the last keystroke and flushes on close). */
export function debounced<A extends unknown[]>(fn: (...args: A) => void, ms: number): { call: (...args: A) => void; flush: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: A | null = null;
  return {
    call(...args) {
      last = args;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const a = last;
        last = null;
        if (a) fn(...a);
      }, ms);
    },
    flush() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const a = last;
      last = null;
      if (a) fn(...a);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      last = null;
    },
  };
}

// ------------------------------------------------------------------------------------------------------ the reply drawer's drafts

export type ReplyDraftFields = { to: string; cc: string; body: string };
export type StoredReplyDraft = ReplyDraftFields & { serverVersion: string };

const MAX_BODY = 100_000;
const str = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);

/** The owner's unsent edits: 24 hours. `serverVersion` is the proposal hash the edits were made against ("none" without one). */
export const replyDrafts = draftNamespace<StoredReplyDraft>("reply-draft", {
  ttlMs: 24 * 3_600_000,
  validate(v) {
    const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
    if (!o) return null;
    const to = str(o.to, 5000);
    const cc = str(o.cc, 5000);
    const body = str(o.body, MAX_BODY);
    const serverVersion = str(o.serverVersion, 128);
    return to === null || cc === null || body === null || serverVersion === null ? null : { to, cc, body, serverVersion };
  },
});

export type StoredAiDraft = { text: string; awaiting: boolean };
/** The generated draft, kept per message for 30 minutes so reopening the drawer does not ask the AI again. */
export const aiDrafts = draftNamespace<StoredAiDraft>("reply-ai", {
  ttlMs: 30 * 60_000,
  validate(v) {
    const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
    if (!o) return null;
    const text = str(o.text, MAX_BODY);
    return text === null || typeof o.awaiting !== "boolean" ? null : { text, awaiting: o.awaiting };
  },
});

// ------------------------------------------------------------------------------------------------------ Home view state (T-234 part 5)

/** Which expanded sections the owner left open on Home (item id = the section id): kept for the tab session, 12 hours at most. */
export const expandedSections = draftNamespace<boolean>("home-open", { ttlMs: 12 * 3_600_000, validate: (v) => (typeof v === "boolean" ? v : null) });

/** The message whose Reply drawer is open (item id "current"): so a reload reopens it (30 minutes at most). An id only, never content. */
export const openDrawer = draftNamespace<{ messageId: string }>("drawer-open", {
  ttlMs: 30 * 60_000,
  validate(v) {
    const id = typeof v === "object" && v !== null ? str((v as Record<string, unknown>).messageId, 256) : null;
    return id ? { messageId: id } : null;
  },
});
