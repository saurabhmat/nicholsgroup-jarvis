// Boolean flags derived from message HEADERS at sync time (T-234 part 2), so Home can leave out bulk mail, calendar
// notifications and auto-replies without storing any header (rule 6: flags only, never values). Pure: headers in, five
// booleans out. Header values are sender-controlled and untrusted (rule 9): they are only tested, never kept or shown.
//
//   is_bulk      List-Unsubscribe or List-Id present, or Precedence: bulk / list / junk (RFC 3834 / de-facto list mail).
//   is_auto      A TRUE auto-reply only: Auto-Submitted: auto-replied, X-Autoreply / X-Autorespond present, Precedence: auto_reply.
//   is_generated Auto-Submitted with any other value except "no" (e.g. auto-generated: system mail; an invoice or a
//                person's CRM can send it). A SOFT signal: a priority sender with an auth pass may skip it.
//   is_calendar  A text/calendar part: top-level Content-Type, a part the response lists, an Exchange "calendarmessage"
//                Content-Class, or a Google Calendar notification (Sender: calendar-notification@google.com).
//   is_auth_pass The FIRST Authentication-Results header whose authserv-id is mx.google.com (Google's own verdict; headers
//                added by the sender or an earlier hop are ignored) says dmarc=pass, or dkim=pass for a domain equal to
//                (or a subdomain of) the From address's domain. Priority-sender treatment applies only when this is true,
//                so a spoofed From cannot claim it. Rows synced before this column existed read false until the required
//                resync (backlog H-048).
//
// Limit: Gmail's metadata format does not list the parts of a multipart message, so a text/calendar part nested in a
// multipart/mixed body is seen only through the Sender / Content-Class headers or the subject prefixes in lane_config.
export type FlagPart = { mimeType?: string | undefined; parts?: readonly FlagPart[] | undefined };
export type MailFlags = { is_bulk: boolean; is_calendar: boolean; is_auto: boolean; is_generated: boolean; is_auth_pass: boolean };
export type FlagContext = {
  /** The parsed From address. Without it there is no auth pass. */
  fromAddress?: string | null | undefined;
  /** Every Authentication-Results header value, in message order. Only the verdict is derived; the text is never kept. */
  authResults?: readonly string[] | undefined;
};

const MAX_DEPTH = 8;
const hasCalendarPart = (p: FlagPart | undefined, depth = 0): boolean => {
  if (!p || typeof p !== "object" || depth > MAX_DEPTH) return false;
  if (/^\s*text\/calendar\b/i.test(typeof p.mimeType === "string" ? p.mimeType : "")) return true;
  const kids: readonly FlagPart[] = Array.isArray(p.parts) ? (p.parts as readonly FlagPart[]) : [];
  return kids.some((c) => hasCalendarPart(c, depth + 1));
};

const GOOGLE_AUTHSERV = "mx.google.com";
const domainInOrUnder = (d: string, base: string) => d !== "" && base !== "" && (d === base || d.endsWith(`.${base}`));

/** True when Google's own Authentication-Results (the first one) shows dmarc=pass, or dkim=pass aligned with the From domain. */
export function authPass(fromAddress: string | null | undefined, authResults: readonly string[] | undefined): boolean {
  const from = (fromAddress ?? "").toLowerCase();
  const fromDomain = from.includes("@") ? from.slice(from.lastIndexOf("@") + 1).trim() : "";
  if (fromDomain === "") return false;
  const header = (authResults ?? []).find((v) => (v.split(";")[0] ?? "").trim().split(/\s+/)[0]?.toLowerCase() === GOOGLE_AUTHSERV);
  if (header === undefined) return false;
  const methods = header.split(";").slice(1).map((m) => m.trim().toLowerCase());
  if (methods.some((m) => /^dmarc=pass\b/.test(m))) return true;
  return methods.some((m) => {
    if (!/^dkim=pass\b/.test(m)) return false;
    const d = /\bheader\.d=([^\s;()]+)/.exec(m)?.[1];
    const i = /\bheader\.i=([^\s;()]+)/.exec(m)?.[1];
    const dom = d ?? (i?.includes("@") ? i.slice(i.lastIndexOf("@") + 1) : i);
    return domainInOrUnder((dom ?? "").replace(/^@/, ""), fromDomain);
  });
}

/** `headers`: lower-case names -> first value. */
export function deriveMailFlags(headers: ReadonlyMap<string, string>, payload?: FlagPart, ctx: FlagContext = {}): MailFlags {
  const h = (n: string) => headers.get(n)?.trim();
  const precedence = (h("precedence") ?? "").toLowerCase();
  const autoSubmitted = (h("auto-submitted") ?? "").toLowerCase();
  const contentType = h("content-type") ?? "";
  const autoReplied = /^auto-replied\b/.test(autoSubmitted);
  const submittedOther = autoSubmitted !== "" && !/^no\b/.test(autoSubmitted);
  return {
    is_bulk: headers.has("list-unsubscribe") || headers.has("list-id") || /^(bulk|list|junk)\b/.test(precedence),
    is_auto: autoReplied || headers.has("x-autoreply") || headers.has("x-autorespond") || /^auto[_-]?reply\b/.test(precedence),
    is_generated: submittedOther && !autoReplied,
    is_calendar:
      /\btext\/calendar\b/i.test(contentType) ||
      hasCalendarPart(payload) ||
      /calendarmessage/i.test(h("content-class") ?? "") ||
      /(^|[<\s])calendar-notification@google\.com>?\s*$/i.test(h("sender") ?? ""),
    is_auth_pass: authPass(ctx.fromAddress, ctx.authResults),
  };
}
