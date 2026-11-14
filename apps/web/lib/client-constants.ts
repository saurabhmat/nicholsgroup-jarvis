// Constants shared by client components and their tests (T-245). A plain module with no directive: a constant exported from a
// "use client" file reaches server code as a client reference, not a value (see tests/directive-exports.test.ts).

/** Briefing auto-generation polling (components/briefing-auto.tsx). */
export const POLL_EVERY_MS = 12_000;
export const POLL_FOR_MS = 3 * 60_000;

/** Reply drawer: shown when a stored draft no longer matches the server's draft (components/reply-drawer.tsx). */
export const STALE_NOTE = "Your earlier unsaved edits were discarded because the draft changed.";

/** Sync now button messages (components/sync-now-button.tsx). */
export const SYNC_NOW_TEXT = {
  started: "Sync started. The times below update in a few seconds.",
  none: "No Google account is connected to sync.",
  forbidden: "Only an owner or technical administrator can start a sync.",
  signedOut: "You are signed out. Sign in again and retry.",
  failed: "Could not start the sync. Try again in a minute.",
  network: "Could not reach the portal. Check your connection and try again.",
} as const;
