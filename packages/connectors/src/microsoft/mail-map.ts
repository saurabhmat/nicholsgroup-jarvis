// The strict mapper of the Microsoft mail sync (T-258, spec §8.2): one Graph message of a folder's delta -> `MessageMeta`, or null.
// Rule 6: no body is ever stored. Three layers keep it out: the request's `$select` names the index fields only; this schema declares only
// the fields below, so `body`, `bodyPreview`, `uniqueBody` and anything else Graph might return anyway are dropped at parse time and never
// read; and the record is rebuilt field by field and checked by the strict `MessageMetaSchema` (no field exists there for a body).
// Graph content is untrusted (rule 9): text is cleaned (controls and bidi removed), bounded and checked like Gmail's, and nothing from a
// response is put in an error or a log line. Flags are always explicit booleans (T-252 review: a missing flag would keep the stored value).
import { z } from "zod";
import { isMailAddress } from "../comms/address";
import { MessageMetaSchema, type MessageMeta, type Recipient } from "../comms/schemas";
import { cleanText } from "../comms/text";
import { OUTLOOK_WEB_HOSTS, type MicrosoftCloud } from "./constants";
import { CANONICAL_FOLDER, type MailFolderName } from "./mail-cursor";

export { MESSAGE_SELECT } from "./mail-query";

/** Our caps where the documentation states none (V-11, categories): ids, categories (count and length), recipients (200, spec §8.2). */
export const MAX_ID_CHARS = 512;
export const MAX_CATEGORIES = 20;
export const MAX_CATEGORY_CHARS = 100;
export const MAX_RECIPIENTS = 200;
const MAX_LABELS = 50;

const emailAddress = z.object({ address: z.string().nullish(), name: z.string().nullish() }).nullish();
const recipient = z.object({ emailAddress });
/** Only these keys are ever read. Everything else in a Graph message (body, bodyPreview, uniqueBody, internetMessageHeaders...) is stripped by the parse. */
const GraphMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string().nullish(),
  webLink: z.string().nullish(),
  from: recipient.nullish(),
  toRecipients: z.array(recipient).nullish(),
  ccRecipients: z.array(recipient).nullish(),
  subject: z.string().nullish(),
  receivedDateTime: z.string().nullish(),
  sentDateTime: z.string().nullish(),
  isRead: z.boolean().nullish(),
  flag: z.object({ flagStatus: z.string().nullish() }).nullish(),
  importance: z.string().nullish(),
  hasAttachments: z.boolean().nullish(),
  inferenceClassification: z.string().nullish(),
  categories: z.array(z.string()).nullish(),
  lastModifiedDateTime: z.string().nullish(),
});
export type GraphMessage = z.infer<typeof GraphMessageSchema>;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Text with no control, line-separator or bidi character: the same set `MessageMetaSchema` refuses (and `cleanText` removes). */
const isCleanText = (s: string): boolean => cleanText(s) === s;
// ISO-8601 as Graph sends it (`2026-11-04T10:00:00Z`, up to 7 fractional digits, or an offset). A string with NO zone is read as UTC (Graph's
// `receivedDateTime` is UTC; `Date.parse` would otherwise use the server's local zone). Anything that is not this shape is unusable.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/i;
export const instant = (v: string | null | undefined): string | null => {
  if (typeof v !== "string" || v.length > 40) return null;
  const m = ISO_TIME.exec(v);
  if (!m) return null;
  // An impossible date (2026-02-30) would roll over into the next month: refuse it.
  const d = new Date(Date.UTC(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, Number(v.slice(8, 10))));
  if (d.toISOString().slice(0, 10) !== v.slice(0, 10)) return null;
  const ms = Date.parse(m[1] === undefined ? `${v}Z` : v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** `webLink` when it is https, on an allow-listed Outlook host of the cloud, without credentials or a port, and plain text; else null. */
export function safeWebLink(value: string | null | undefined, cloud: MicrosoftCloud = "commercial"): string | null {
  // Printable ASCII only, no space, no backslash and no encoded backslash: the parser would rewrite some of these into a different URL.
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || !/^[\x21-\x7e]+$/.test(value) || value.includes("\\") || /%5c/i.test(value) || !URL.canParse(value)) return null;
  const u = new URL(value);
  const ok = u.protocol === "https:" && OUTLOOK_WEB_HOSTS[cloud].has(u.hostname) && u.port === "" && u.username === "" && u.password === "";
  // The normalised form is stored, so what the row links to is what was checked.
  return ok && u.href.length <= 2048 ? u.href : null;
}

function recipients(list: z.infer<typeof recipient>[] | null | undefined): Recipient[] {
  const out: Recipient[] = [];
  for (const r of list ?? []) {
    const address = (r.emailAddress?.address ?? "").trim().toLowerCase();
    // Only the bad ADDRESS is dropped (as Gmail's parser does); a hostile one never costs the rest of the message.
    if (address.length < 3 || address.length > 320 || !isCleanText(address) || !isMailAddress(address)) continue;
    const name = cleanText(r.emailAddress?.name ?? "").slice(0, 200);
    out.push(name !== "" && name.toLowerCase() !== address ? { address, name } : { address });
    if (out.length >= MAX_RECIPIENTS) break;
  }
  return out;
}

export type MapContext = {
  folder: MailFolderName;
  /** Start of the window (ISO): a message received before it is dropped, never indexed (the first load reads the folder in full, newest first). */
  since: string;
  cloud?: MicrosoftCloud;
};

/**
 * `{ meta }` for an indexable message, `{ dropped: "old" }` for one outside the window, `{ dropped: "unusable" }` for one that cannot be mapped
 * (no usable id or time, a record that fails the strict schema). Callers count the drops; no content is logged.
 */
export function mapMessage(raw: unknown, ctx: MapContext): { meta: MessageMeta } | { dropped: "old" | "unusable" } {
  const parsed = GraphMessageSchema.safeParse(raw);
  if (!parsed.success) return { dropped: "unusable" };
  const m = parsed.data;
  if (m.id === "" || m.id.length > MAX_ID_CHARS || CONTROL.test(m.id)) return { dropped: "unusable" };
  // Never invent a time. Sent Items use the sent time (spec §8.2); a message without a usable time is skipped.
  const received = (ctx.folder === "sentitems" ? (instant(m.sentDateTime) ?? instant(m.receivedDateTime)) : (instant(m.receivedDateTime) ?? instant(m.sentDateTime)));
  if (received === null) return { dropped: "unusable" };
  if (Date.parse(received) < Date.parse(ctx.since)) return { dropped: "old" };

  const seen = new Set<string>();
  const labels: string[] = [];
  const add = (l: string) => {
    if (!seen.has(l) && labels.length < MAX_LABELS) {
      seen.add(l);
      labels.push(l);
    }
  };
  if (ctx.folder === "sentitems") add("SENT");
  if ((m.inferenceClassification ?? "").toLowerCase() === "other") add("OTHER");
  // `cat:` keeps a user category named "SENT" from posing as a system marker.
  for (const c of (m.categories ?? []).slice(0, MAX_CATEGORIES)) {
    const name = cleanText(c).slice(0, MAX_CATEGORY_CHARS);
    if (name !== "") add(`cat:${name}`);
  }

  const from = recipients(m.from ? [m.from] : [])[0];
  const thread = m.conversationId ?? null;
  const base = {
    message_id: m.id,
    thread_id: thread !== null && thread !== "" && thread.length <= MAX_ID_CHARS && !CONTROL.test(thread) ? thread : null,
    source_url: safeWebLink(m.webLink, ctx.cloud),
    from_address: from?.address ?? null,
    from_name: from?.name ?? null,
    to_recipients: recipients(m.toRecipients),
    cc_recipients: recipients(m.ccRecipients),
    subject: ((): string | null => {
      const s = cleanText((m.subject ?? "").slice(0, 2048)).slice(0, 998);
      return s === "" ? null : s;
    })(),
    received_at: received,
    is_read: m.isRead === true,
    is_starred: (m.flag?.flagStatus ?? "").toLowerCase() === "flagged",
    is_important: (m.importance ?? "").toLowerCase() === "high",
    has_attachments: m.hasAttachments === true,
    folder: CANONICAL_FOLDER[ctx.folder],
    labels,
    source_updated_at: instant(m.lastModifiedDateTime),
  };
  // Sender-controlled text broke a limit: clear ONLY the field that failed (never the whole record) and try again. The identity (id), the time,
  // the folder and the flags are ours, so a failure there is the only reason to drop the message.
  const CLEARABLE: Record<string, unknown> = { thread_id: null, source_url: null, from_address: null, from_name: null, to_recipients: [], cc_recipients: [], subject: null, labels: [], source_updated_at: null };
  let record: Record<string, unknown> = base;
  for (let attempt = 0; attempt < 12; attempt++) {
    const parsed = MessageMetaSchema.safeParse(record);
    if (parsed.success) return { meta: parsed.data };
    const keys = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")))];
    if (keys.some((k) => !(k in CLEARABLE) || JSON.stringify(record[k]) === JSON.stringify(CLEARABLE[k]))) return { dropped: "unusable" };
    const fixable = keys;
    record = { ...record, ...Object.fromEntries(fixable.map((k) => [k, CLEARABLE[k]])) };
  }
  return { dropped: "unusable" };
}
