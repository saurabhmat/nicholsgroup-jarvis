// Header-derived flags for Microsoft mail (T-259, spec §8.4). Graph returns `internetMessageHeaders` only on a single-message read with `$select`,
// never in a delta page, so the sync reads the headers of the INBOX messages of a page one by one, classifies them with the shared `mail-flags`
// rules and keeps the five booleans only. A header NAME or VALUE is never stored, logged or put in an error (rules 6 and 9): this file turns a
// response into booleans and forgets it.
//
// `is_auth_pass` is FALSE for every Microsoft message (plan-review "T-259: spec §15 verify items", V-13): the `Authentication-Results` header Exchange
// Online adds has no documented service identifier, so the tenant's own header cannot be told from one a sender put in the message. The header is
// therefore never parsed for a pass (the classifier is called WITHOUT it), and the flag is set to false explicitly.
//
// Bounds (the sync does not know which messages of a delta page are new, only which are in it, so it reads for every inbox message of a page that
// has none yet, newest first, up to these limits; the headers do not change, so a re-read for a changed message gives the same booleans):
//  - HEADER_READS_PER_PAGE reads in one sync page, and
//  - HEADER_READS_PER_WINDOW reads per connection in any HEADER_WINDOW_MS (a first load of a large inbox cannot multiply requests without limit).
// A message over a bound is indexed WITHOUT flags: on a first insert the flags are false, on an update the stored ones are kept (the page writer
// keeps an absent flag), never guessed. It is read again when it next appears in a delta page (a later change to it).
import { z } from "zod";
import { deriveMailFlags } from "../comms/mail-flags";

export const HEADER_READS_PER_PAGE = 50;
export const HEADER_READS_PER_WINDOW = 1000;
export const HEADER_WINDOW_MS = 10 * 60_000;
/** Header lines and sizes we look at: a hostile message cannot make this work unbounded. */
const MAX_HEADERS = 1000;
const MAX_NAME_CHARS = 200;
const MAX_VALUE_CHARS = 4096;
const MAX_TRACKED_CONNECTIONS = 1000;

export const HEADERS_QUERY = "$select=internetMessageHeaders";
export const EVENT_MESSAGE_TYPE = "#microsoft.graph.eventMessage";

export type HeaderFlags = { is_bulk: boolean; is_calendar: boolean; is_auto: boolean; is_generated: boolean; is_auth_pass: false };

const HeadersAnswerSchema = z.object({ internetMessageHeaders: z.array(z.unknown()).max(MAX_HEADERS).nullish() });

/** The flags of one single-message answer, or null when the answer is not usable (no flags are then set). The answer is not kept. */
export function flagsFromAnswer(answer: unknown): HeaderFlags | null {
  const parsed = HeadersAnswerSchema.safeParse(answer);
  if (!parsed.success || parsed.data.internetMessageHeaders == null) return null;
  const headers = new Map<string, string>();
  for (const h of parsed.data.internetMessageHeaders) {
    if (typeof h !== "object" || h === null) continue;
    const { name, value } = h as { name?: unknown; value?: unknown };
    if (typeof name !== "string" || name === "" || name.length > MAX_NAME_CHARS) continue;
    const key = name.toLowerCase();
    if (!headers.has(key)) headers.set(key, typeof value === "string" ? value.slice(0, MAX_VALUE_CHARS) : "");
  }
  const f = deriveMailFlags(headers); // no Authentication-Results and no From: never a pass
  return { is_bulk: f.is_bulk, is_calendar: f.is_calendar, is_auto: f.is_auto, is_generated: f.is_generated, is_auth_pass: false };
}

/** A per-connection budget of header reads over a rolling window (in memory: a restart only gives a fresh window, the per-page bound still holds). */
export function createHeaderBudget(now: () => number, perWindow = HEADER_READS_PER_WINDOW, windowMs = HEADER_WINDOW_MS) {
  const used = new Map<string, { since: number; count: number }>();
  return {
    /** Takes up to `want` reads from the connection's window; returns how many were granted. */
    take(connectionId: string, want: number): number {
      const t = now();
      let e = used.get(connectionId);
      if (e === undefined || t - e.since >= windowMs) {
        if (used.size >= MAX_TRACKED_CONNECTIONS) for (const [k, v] of used) if (t - v.since >= windowMs) used.delete(k);
        e = { since: t, count: 0 };
        used.set(connectionId, e);
      }
      const granted = Math.max(0, Math.min(want, perWindow - e.count));
      e.count += granted;
      return granted;
    },
  };
}
