// The timings of the live Messages page (T-290, spec 9.4). A plain module (no directive), so a server component, a client component and a test all read the same numbers.
//
// MICROSOFT'S TERMS (vendor facts A3): "If your app polls to see whether a resource has changed, you can only do that once per day"; "When polling for new messages, you must specify a date range".
// The portal therefore NEVER polls Microsoft in a loop. The ONLY loop is `ACTIVITY_POLL_MS`, and it asks the PORTAL'S OWN database (`GET /api/lanes/<lane>/messages/activity`: one row of times,
// no Graph call). Microsoft is read again only (a) because a notification arrived (the database's `last_notice_at` moved), or (b) because the person acted (opened a chat, pressed Refresh, came
// back to the window), and (b) at most once per `REFETCH_MIN_GAP_MS`.

/** How often a VISIBLE Messages page asks its own database whether a notice arrived. Stops while the tab is hidden. Never a request to Microsoft. */
export const ACTIVITY_POLL_MS = 30_000;
/** Refresh and window focus read Microsoft at most this often (a refetch caused by a notice is not held back by it: it is one per notice). */
export const REFETCH_MIN_GAP_MS = 60_000;
/** The navigation dot asks the database again at most this often (on a page change or when the tab comes back); it has no timer of its own. */
export const DOT_MIN_GAP_MS = 20_000;
/** The activity route: requests per person per lane in `ACTIVITY_LIMIT_WINDOW_MS` (a poll every 30 s from two tabs is 4 a minute; the dot adds a few). */
export const ACTIVITY_LIMIT_MAX = 20;
export const ACTIVITY_LIMIT_WINDOW_MS = 60_000;
/** What Messages asks for newer messages from when a conversation shows none yet: a date range far enough back to be one page, never an open-ended read. */
export const NEWER_EPOCH = "2020-01-01T00:00:00.000Z";
/** The two re-read routes (the chat list again, newer messages of the open chat) read MICROSOFT, so their per-person allowance is smaller: a client bug can never become a request storm to Microsoft. */
export const READ_LIMIT_MAX = 12;
export const READ_LIMIT_WINDOW_MS = 60_000;
/** A notice newer than this (by the SERVER's clock, at the first answer) may have come after the server read the page was drawn from: the page re-reads once. */
export const NOTICE_FRESH_MS = 30_000;
/** While the FIRST answer of the activity route keeps failing: after this many failures in a row the loop asks at most every FIRST_ANSWER_BACKOFF_MS (and again when the tab comes back). */
export const FIRST_ANSWER_FAILURES_BEFORE_BACKOFF = 3;
export const FIRST_ANSWER_BACKOFF_MS = 5 * 60_000;
/** An answer that means "not for this person, ever, in this page view": the loop stops for the page view. */
export const FIRST_ANSWER_FINAL_STATUSES: readonly number[] = [401, 403, 404];
