// The cursor and the link rules of the Microsoft calendar sync (T-067, spec §9 and decision D-59: the person's DEFAULT calendar only).
//
// Cursor: `m1.<connection id>.c:<base64url JSON>` of `{ v: 1, w: { s, e }, k: "n" | "d", l }`: ONE link `l` (`k` = "n": the nextLink of a load in
// progress, "d": the deltaLink of a finished load) and the window `w` (start and end, UTC midnights) the load was created for. Microsoft documents
// the window on the INITIAL request only ("you must specify it in the initial delta request"); every later request is the returned link, sent back
// unchanged. The cursor holds the window so the half-horizon reload can see how far ahead it still reaches, and so a link is only ever accepted
// together with the window it belongs to. The cursor carries no token (a link holds Graph's own opaque paging or delta state, no credential).
//
// Links are OPAQUE, but a link is used only after `validateCalendarLink`: it must start with the cloud's exact Graph origin, its path must be exactly
// `/v1.0/me/calendarView/delta`, and its query must be exactly one `$skiptoken` or one `$deltatoken`, optionally with the two window parameters
// byte for byte as our own initial request sent them. The request is always REBUILT on the path template; only the validated query is reused, so a
// link can never move a request to another host, path, mailbox or calendar, nor ask for more than we ask for. Anything else is a malformed cursor
// (`fullResyncRequired`); a link Graph returns that fails the rule is never stored.
//
// Bounds: a link is at most MAX_LINK_CHARS (the longest query the Graph client sends, 4,096 characters, plus the fixed part), so the largest allowed
// state encodes far below the 16,384 of the cursor table. A state that would not fit is refused (`encodeCalCursor` returns null: the caller fails
// safe with a resync), never cut.
//
// The index rows of this sync carry ONE fixed calendar id, DEFAULT_CALENDAR_ID, for "the default calendar". It is not a Graph id: the real id of the
// default calendar is never read (no `GET /me/calendars`, D-59), and nothing in the index or its readers needs it.
import { z } from "zod";
import { CommsCursorSchema, type CommsCursor } from "../comms/schemas";
import { isOpaqueQuery, MAX_RAW_QUERY } from "./api";
import { GRAPH_COMMERCIAL_BASE } from "./constants";

/**
 * The calendar id of every row of this sync. `microsoft:default`: it has the colon that the characters of a Graph id (letters, digits, `_`, `-`, `=`,
 * `+`, `.`) never include, so it cannot equal a real Graph calendar id; it is stable across runs, accepted by the id-parameter rule of `readBody`
 * (`ProviderIdParamSchema` allows `:`), and fits the table's 512 characters. Google rows use `primary` (another connection, another provider).
 */
export const DEFAULT_CALENDAR_ID = "microsoft:default";

export const CAL_DELTA_PATH = "/me/calendarView/delta";
const BASE = new URL(GRAPH_COMMERCIAL_BASE);
/** The fixed part of a link before its query: origin, `/v1.0`, the delta path and `?`. */
export const CAL_LINK_HEAD = `${BASE.origin}${BASE.pathname.replace(/\/+$/, "")}${CAL_DELTA_PATH}`;
/** A link is at most this long: its head, `?` and the longest query the Graph client will send. A longer one is never stored or cut. */
export const MAX_LINK_CHARS = CAL_LINK_HEAD.length + 1 + MAX_RAW_QUERY;
/** The cursor table's limit (`CommsCursorSchema`). */
export const MAX_CURSOR_CHARS = 16_384;
/** The most days of the window behind today (spec §9: at most 180). */
export const MAX_BACK_DAYS = 180;
const DAY_MS = 86_400_000;

export type CalWindow = { s: string; e: string };
export type CalState = { v: 1; w: CalWindow; k: "n" | "d"; l: string };

export const cursorPrefix = (connectionId: string): string => `m1.${connectionId}.c:`;

const DAY_ISO = /^\d{4}-\d\d-\d\dT00:00:00\.000Z$/;
const isWindow = (w: CalWindow): boolean => DAY_ISO.test(w.s) && DAY_ISO.test(w.e) && Number.isFinite(Date.parse(w.s)) && Number.isFinite(Date.parse(w.e)) && Date.parse(w.e) > Date.parse(w.s);

export const epochDay = (ms: number): number => Math.floor(ms / DAY_MS);

/** The window of a fresh full load: `backDays` before today to `forwardDays` after it, as UTC midnights in ISO 8601. */
export function newWindow(nowMs: number, backDays: number, forwardDays: number): CalWindow {
  const today = epochDay(nowMs);
  return { s: new Date((today - Math.min(MAX_BACK_DAYS, Math.max(1, backDays))) * DAY_MS).toISOString(), e: new Date((today + Math.max(1, forwardDays)) * DAY_MS).toISOString() };
}

/** The two window parameters, exactly as the initial request sends them (and as a link may repeat them). */
export const windowParams = (w: CalWindow): [string, string] => [`startDateTime=${w.s}`, `endDateTime=${w.e}`];
/** The query of the INITIAL request: the window and nothing else (`$select`, `$filter`, `$orderby`, `$search` and `$expand` are not supported on this delta). */
export const initialQuery = (w: CalWindow): string => windowParams(w).join("&");

/** Whole days between `nowMs` and the end of the window. */
export const daysAhead = (w: CalWindow, nowMs: number): number => epochDay(Date.parse(w.e)) - epochDay(nowMs);

/** The half-horizon rule (as T-064): when the forward part of the window has run down below half of `forward_days`, a fresh full load starts. */
export const reloadDue = (w: CalWindow, nowMs: number, forwardDays: number): boolean => daysAhead(w, nowMs) < Math.floor(forwardDays / 2);

/**
 * A link's query is exactly one `$skiptoken=<opaque>` or one `$deltatoken=<opaque>`, optionally with each window parameter once, byte for byte as our
 * initial request sent it. Any other key, a repeated one, an empty parameter or an empty token is refused.
 */
export function isAllowedLinkQuery(query: string, w: CalWindow): boolean {
  const [start, end] = windowParams(w);
  let tokens = 0;
  const seen = new Set<string>();
  for (const part of query.split("&")) {
    if (seen.has(part)) return false;
    seen.add(part);
    if (/^\$(skiptoken|deltatoken)=.+/.test(part)) tokens += 1;
    else if (part !== start && part !== end) return false;
  }
  return tokens === 1;
}

/**
 * The query of a next or delta link when it may be used for the window `w`, else null. Valid = printable ASCII within MAX_LINK_CHARS, no fragment,
 * the exact head `https://graph.microsoft.com/v1.0/me/calendarView/delta` of the cloud this build serves (the text before `?`, compared as a whole, not
 * through a URL parser), and a query that is URL-safe and passes `isAllowedLinkQuery`.
 */
export function validateCalendarLink(link: unknown, w: CalWindow): { query: string } | null {
  if (typeof link !== "string" || link.length === 0 || link.length > MAX_LINK_CHARS || !/^[\x21-\x7e]+$/.test(link) || link.includes("#")) return null;
  const q = link.indexOf("?");
  if (q < 0 || link.slice(0, q) !== CAL_LINK_HEAD) return null;
  const query = link.slice(q + 1);
  if (query === "" || !isOpaqueQuery(query) || !isAllowedLinkQuery(query, w)) return null;
  return { query };
}

const StateSchema = z.strictObject({
  v: z.literal(1),
  w: z.strictObject({ s: z.string().max(30), e: z.string().max(30) }),
  k: z.enum(["n", "d"]),
  l: z.string().min(1).max(MAX_LINK_CHARS),
});

/**
 * The state when the cursor is well-formed AND belongs to this connection AND its window is valid AND its link passes `validateCalendarLink` for that
 * window; null otherwise (the caller answers `fullResyncRequired`). Never throws. A mail cursor (`m1.<id>.m:`), a Google cursor (`g1.`), another
 * connection's cursor and an oversized value all fail the prefix or the size check.
 */
export function parseCalCursor(value: string, connectionId: string): CalState | null {
  const prefix = cursorPrefix(connectionId);
  if (value.length > MAX_CURSOR_CHARS || !value.startsWith(prefix)) return null;
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{1,16384}$/.test(encoded)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = StateSchema.safeParse(json);
  if (!parsed.success || !isWindow(parsed.data.w) || validateCalendarLink(parsed.data.l, parsed.data.w) === null) return null;
  return parsed.data;
}

/** The cursor for a state, or null when it would not fit the 16 KB limit (the caller fails safe: a resync, never a cut link). */
export function encodeCalCursor(connectionId: string, state: CalState): CommsCursor | null {
  const value = `${cursorPrefix(connectionId)}${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
  return CommsCursorSchema.safeParse({ value }).success ? { value } : null;
}
