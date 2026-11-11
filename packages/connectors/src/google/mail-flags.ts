// Boolean flags derived from message HEADERS at sync time (T-234 part 2), so Home can leave out bulk mail, calendar
// notifications and auto-replies without storing any header (rule 6: flags only, never values). Pure: headers in, three
// booleans out. Header values are sender-controlled and untrusted (rule 9): they are only tested, never kept or shown.
//
//   is_bulk     List-Unsubscribe or List-Id present, or Precedence: bulk / list / junk (RFC 3834 / de-facto list mail).
//   is_auto     Auto-Submitted other than "no" (RFC 3834), X-Autoreply / X-Autorespond present, or Precedence: auto_reply.
//   is_calendar a text/calendar part: top-level Content-Type, a part the response lists, an Exchange "calendarmessage"
//               Content-Class, or a Google Calendar notification (Sender: calendar-notification@google.com).
//
// Limit: Gmail's metadata format does not list the parts of a multipart message, so a text/calendar part nested in a
// multipart/mixed body is seen only through the Sender / Content-Class headers or the subject prefixes in lane_config.
export type FlagPart = { mimeType?: string | undefined; parts?: readonly FlagPart[] | undefined };
export type MailFlags = { is_bulk: boolean; is_calendar: boolean; is_auto: boolean };

const MAX_DEPTH = 8;
const hasCalendarPart = (p: FlagPart | undefined, depth = 0): boolean => {
  if (!p || depth > MAX_DEPTH) return false;
  if (/^\s*text\/calendar\b/i.test(p.mimeType ?? "")) return true;
  return (p.parts ?? []).some((c) => hasCalendarPart(c, depth + 1));
};

/** `headers`: lower-case names -> first value. */
export function deriveMailFlags(headers: ReadonlyMap<string, string>, payload?: FlagPart): MailFlags {
  const h = (n: string) => headers.get(n)?.trim();
  const precedence = (h("precedence") ?? "").toLowerCase();
  const autoSubmitted = (h("auto-submitted") ?? "").toLowerCase();
  const contentType = h("content-type") ?? "";
  return {
    is_bulk: headers.has("list-unsubscribe") || headers.has("list-id") || /^(bulk|list|junk)\b/.test(precedence),
    is_auto: (autoSubmitted !== "" && !/^no\b/.test(autoSubmitted)) || headers.has("x-autoreply") || headers.has("x-autorespond") || /^auto[_-]?reply\b/.test(precedence),
    is_calendar:
      /\btext\/calendar\b/i.test(contentType) ||
      hasCalendarPart(payload) ||
      /calendarmessage/i.test(h("content-class") ?? "") ||
      /<?calendar-notification@google\.com>?\s*$/i.test(h("sender") ?? ""),
  };
}
