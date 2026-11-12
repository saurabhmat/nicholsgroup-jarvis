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
//   is_auth_pass The TOPMOST Authentication-Results header, only when its authserv-id is exactly mx.google.com (Google's
//                own verdict), with comments and quoted strings removed, says dmarc=pass with header.from equal to the
//                From domain, or dkim=pass for a domain equal to (or a subdomain of: relaxed alignment) the From domain. Priority-sender treatment applies only when this is true,
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

const MAX_AUTH_RESULTS_CHARS = 4096;

/**
 * Removes RFC 8601 / RFC 5322 comments `( ... )` (nested, with escapes) and quoted strings `"..."` from a header value,
 * so a ";" or a "dmarc=pass" inside them (sender-controlled: the SPF comment echoes the envelope sender, smtp.mailfrom
 * can be a quoted local part) can never be read as a result (T-234 part 2 security re-check H1). Null when unbalanced:
 * the caller fails closed.
 */
export function stripCommentsAndQuotes(v: string): string | null {
  let out = "";
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === "\\" && (inQuote || depth > 0)) {
      i++; // escaped character inside a comment or quote: skipped with it
      continue;
    }
    if (inQuote) {
      if (c === '"') inQuote = false;
      continue;
    }
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      if (depth === 0) return null;
      depth--;
      if (depth === 0) out += " ";
      continue;
    }
    if (depth > 0) continue;
    if (c === '"') {
      inQuote = true;
      out += " ";
      continue;
    }
    out += c;
  }
  return depth === 0 && !inQuote ? out : null;
}

/**
 * True when Google's own Authentication-Results shows dmarc=pass FOR THE FROM DOMAIN (header.from equal to it), or
 * dkim=pass with a signing domain equal to (or under: DMARC relaxed alignment) the From domain. Only the TOPMOST header is
 * read (Google prepends its own; any lower one may have been written by the sender) and only when its authserv-id is
 * exactly mx.google.com. Comments and quoted strings are removed first; an unbalanced or oversized header is no pass.
 */
export function authPass(fromAddress: string | null | undefined, authResults: readonly string[] | undefined): boolean {
  const from = (fromAddress ?? "").toLowerCase().trim();
  const fromDomain = from.includes("@") ? from.slice(from.lastIndexOf("@") + 1).trim() : "";
  if (fromDomain === "" || !/^[a-z0-9.-]+$/.test(fromDomain)) return false;
  const top = authResults?.[0];
  if (typeof top !== "string" || top.length > MAX_AUTH_RESULTS_CHARS) return false;
  const clean = stripCommentsAndQuotes(top);
  if (clean === null) return false;
  const [servPart, ...results] = clean.split(";");
  // authserv-id, optionally followed by a version number ("mx.google.com 1").
  if ((servPart ?? "").trim().toLowerCase().split(/\s+/)[0] !== GOOGLE_AUTHSERV) return false;
  const props = (r: string) => {
    const tokens = r.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const [methodResult, ...rest] = tokens;
    const map = new Map<string, string>();
    for (const t of rest) {
      const eq = t.indexOf("=");
      if (eq > 0) map.set(t.slice(0, eq), t.slice(eq + 1));
    }
    return { methodResult: methodResult ?? "", map };
  };
  return results.some((r) => {
    const { methodResult, map } = props(r);
    if (methodResult === "dmarc=pass") return map.get("header.from") === fromDomain;
    if (methodResult === "dkim=pass") {
      const d = map.get("header.d");
      const i = map.get("header.i");
      const dom = d ?? (i?.includes("@") ? i.slice(i.lastIndexOf("@") + 1) : i);
      return domainInOrUnder((dom ?? "").replace(/^@/, ""), fromDomain);
    }
    return false;
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
