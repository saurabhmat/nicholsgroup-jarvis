// "Needs your attention" and the Money card (T-231b): rules over thread METADATA (core.briefing_threads), no AI, no
// bodies. Every pattern comes from lane_config.briefing. Sender patterns are anchored ("name@" = local part, "x.com" =
// domain or subdomain, a word = in the local part); subject patterns match whole words. Order of the top list
// (acceptance order):
//   1. lane_config priority_senders (address or @domain) that PASSED AUTHENTICATION (isAuthPass, derived at sync from Google's
//      own Authentication-Results): not subject to the soft exclusions. A priority sender without an auth pass (spoofed From,
//      or a row synced before the column existed: needs the resync, backlog H-048) is ranked as an ordinary sender.
//      Hard exclusions for everyone: one-time codes and the header flags calendar / true auto-reply.
//   2. threads waiting on the owner: last message from a real person, not the owner, and either the owner already wrote
//      in the thread or the message was read and left unanswered
//   3. unread mail from real people (not automated, not excluded)
//   4. security alerts (new sign-in, critical vulnerability, ...) from lane_config security_senders domains only
//   5. repeated bot/CI failures (one item per sender domain); within a tier, older first (age)
// Excluded before ranking: OTP codes, calendar invitations/updates, auto-replies, bulk/marketing mail (header flag or the org's
// own newsletter senders), excluded labels (promotions, social, forums), newsletters, social networks, bank transaction alerts
// (statements and due dates are kept), single bot/CI messages (and automated senders' CI-style subjects).

import { httpsUrl } from "./url";

export type ThreadRow = {
  connectionId: string;
  threadKey: string;
  messageId: string;
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  receivedAt: string;
  sourceUrl: string | null;
  labels: string[];
  isImportant: boolean;
  lastIsOwner: boolean;
  ownerReplied: boolean;
  unreadCount: number;
  inboundCount: number;
  /** Flags derived from headers at sync time (T-234 part 2; never the headers themselves). Absent = false (older rows). */
  isBulk?: boolean;
  isCalendar?: boolean;
  isAuto?: boolean;
  /** Auto-Submitted other than no / auto-replied (e.g. auto-generated): a soft signal. */
  isGenerated?: boolean;
  /** Google's Authentication-Results passed for the From domain (dmarc, or aligned dkim). False on rows synced before the column. */
  isAuthPass?: boolean;
};

export type AttentionRules = {
  prioritySenders: readonly string[];
  securitySubjects: readonly string[];
  securitySenders: readonly string[];
  exclusions: {
    labels: readonly string[];
    newsletter_senders: readonly string[];
    social_senders: readonly string[];
    bot_senders: readonly string[];
    bot_failure_words: readonly string[];
    bot_failure_repeat: number;
    otp_subjects: readonly string[];
    bank_alert_subjects: readonly string[];
    bank_keep_subjects: readonly string[];
    automated_senders: readonly string[];
    org_newsletter_senders: readonly string[];
    calendar_subjects: readonly string[];
    auto_reply_subjects: readonly string[];
    bot_subjects: readonly string[];
  };
  money: { invoice: readonly string[]; bill: readonly string[]; renewal: readonly string[]; failed_payment: readonly string[] };
};

export type AttentionKind = "priority" | "security" | "waiting" | "unread" | "repeated_failures";

export type AttentionThread = {
  key: string;
  kind: AttentionKind;
  /** One line: why it is here (rule-based, no AI). */
  reason: string;
  thread: ThreadRow;
  /** For repeated failures: how many failure messages from this sender. */
  count?: number;
};

export type MoneyKind = "invoice" | "bill" | "renewal" | "failed_payment";
export type MoneyThread = { key: string; kind: MoneyKind; thread: ThreadRow };

const lower = (v: string) => v.toLowerCase();
const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive: "otp" matches "Your OTP" but not "footprint". */
export function subjectHas(subject: string | null | undefined, words: readonly string[]): boolean {
  if (!subject) return false;
  const s = lower(subject);
  // A pattern ending in "#" ("build #") may be followed by digits ("Build #1234 failed").
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${escapeRe(lower(w))}${w.endsWith("#") ? "($|[^a-z])" : "($|[^a-z0-9])"}`).test(s));
}

/** Case-insensitive prefix match on the trimmed subject ("Invitation:" matches "Invitation: Standup", not "Re: Invitation: ..."). */
export function subjectStarts(subject: string | null | undefined, prefixes: readonly string[]): boolean {
  if (!subject) return false;
  const s = lower(subject).trimStart();
  return prefixes.some((p) => s.startsWith(lower(p)));
}

/** Anchored sender match: "name@" = local part exactly, "name@x.com" = that address, "x.com" = domain or a subdomain, a word = in the local part. */
export function senderHas(address: string | null | undefined, patterns: readonly string[]): boolean {
  if (!address) return false;
  const a = lower(address);
  const at = a.lastIndexOf("@");
  const local = at >= 0 ? a.slice(0, at) : a;
  const domain = at >= 0 ? a.slice(at + 1) : "";
  return patterns.some((raw) => {
    const p = lower(raw);
    if (p.endsWith("@")) return local === p.slice(0, -1);
    if (p.includes("@")) return a === p; // a full address ("weekly@example.com")
    if (p.includes(".") && !p.includes("@")) return domain === p || domain.endsWith(`.${p}`);
    return local.includes(p);
  });
}

const domainOf = (a: string) => a.split("@")[1]?.toLowerCase() ?? "";

export function isPrioritySender(address: string | null, senders: readonly string[]): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  return senders.some((s) => {
    const p = s.toLowerCase();
    return p.startsWith("@") ? `@${domainOf(a)}` === p : a === p;
  });
}

/** A priority sender whose mail passed authentication. Only this gets priority treatment; a spoofed From does not. */
export const isTrustedPriority = (t: ThreadRow, r: AttentionRules): boolean => t.isAuthPass === true && isPrioritySender(t.fromAddress, r.prioritySenders);

/** `hard`: the exclusion comes from a header flag or a one-time code, so nobody (not even an authenticated priority sender) skips it. */
export type Classified = { excluded: string | null; hard: boolean; automated: boolean; bot: boolean; security: boolean };

/**
 * Why a thread is left out (null = kept), and the sender class. Security alerts from trusted senders are never excluded.
 * Order: one-time codes, calendar invitations/updates, auto-replies, bulk mail (header flag or the org's own newsletter
 * senders), labels, newsletters, social, bank alerts, bot/CI. The same function feeds Home and the AI briefing input.
 */
export function classify(t: ThreadRow, r: AttentionRules): Classified {
  const x = r.exclusions;
  const security = subjectHas(t.subject, r.securitySubjects) && senderHas(t.fromAddress, r.securitySenders);
  const bot = senderHas(t.fromAddress, x.bot_senders);
  const automated = bot || t.isGenerated === true || senderHas(t.fromAddress, x.automated_senders);
  if (security) return { excluded: null, hard: false, automated, bot, security };
  // Hard: one-time codes and the header flags (calendar part, true auto-reply). Soft: everything else, including a subject-prefix-only
  // calendar/auto-reply match and auto-generated mail; an authenticated priority sender skips the soft ones.
  let excluded: string | null = null;
  let hard = true;
  if (subjectHas(t.subject, x.otp_subjects)) excluded = "otp";
  else if (t.isCalendar === true) excluded = "calendar";
  else if (t.isAuto === true) excluded = "auto_reply";
  else {
    hard = false;
    if (subjectStarts(t.subject, x.calendar_subjects)) excluded = "calendar";
    else if (subjectStarts(t.subject, x.auto_reply_subjects)) excluded = "auto_reply";
    else if (t.isGenerated === true) excluded = "generated";
    else excluded = classifyBulkAndBelow(t, x, bot, automated);
  }
  return { excluded, hard: excluded !== null && hard, automated, bot, security };
}

function classifyBulkAndBelow(t: ThreadRow, x: AttentionRules["exclusions"], bot: boolean, automated: boolean): string | null {
  let excluded: string | null = null;
  if (t.isBulk === true || senderHas(t.fromAddress, x.org_newsletter_senders)) excluded = "bulk";
  else if (t.labels.some((l) => x.labels.some((e) => lower(e) === lower(l)))) excluded = "label";
  else if (senderHas(t.fromAddress, x.newsletter_senders)) excluded = "newsletter";
  else if (senderHas(t.fromAddress, x.social_senders)) excluded = "social";
  else if (subjectHas(t.subject, x.bank_alert_subjects) && !subjectHas(t.subject, x.bank_keep_subjects)) excluded = "bank_alert";
  else if (bot) excluded = "bot";
  else if (automated && subjectHas(t.subject, x.bot_subjects)) excluded = "bot_subject";
  return excluded;
}

/** "3h", "2d", "under an hour". */
export function ageLabel(iso: string, now: Date): string {
  const h = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 3_600_000));
  if (h < 1) return "under an hour";
  if (h < 48) return `${String(h)}h`;
  return `${String(Math.round(h / 24))}d`;
}

const senderLabel = (t: ThreadRow) => t.fromName ?? t.fromAddress ?? "Unknown sender";

/** Ranks the attention list; returns the top `limit` (default 5) and how many more qualified. */
export function rankAttention(rows: ThreadRow[], r: AttentionRules, now: Date, limit = 5): { top: AttentionThread[]; more: number } {
  const out: { item: AttentionThread; tier: number }[] = [];
  const failures = new Map<string, ThreadRow[]>();
  for (const t of rows) {
    const c = classify(t, r);
    const priority = isTrustedPriority(t, r);
    if (c.excluded === "bot" && !priority) {
      if (subjectHas(t.subject, r.exclusions.bot_failure_words)) {
        const k = domainOf(t.fromAddress ?? "") || "unknown";
        failures.set(k, [...(failures.get(k) ?? []), t]);
      }
      continue;
    }
    // Authenticated priority senders skip the soft exclusions; the hard ones (codes, calendar and auto-reply header flags) hold for everyone.
    if (c.excluded && !(priority && !c.hard)) continue;
    if (t.lastIsOwner) continue; // the owner answered last: not waiting on anyone
    const unread = t.unreadCount > 0;
    const ago = ageLabel(t.receivedAt, now);
    const person = !c.automated;
    let item: { tier: number; kind: AttentionKind; reason: string } | null = null;
    if (priority) item = { tier: 0, kind: "priority", reason: `Priority sender${unread ? ", unread" : ", not answered"} · ${ago}` };
    else if (person && (t.ownerReplied || !unread)) item = { tier: 1, kind: "waiting", reason: t.ownerReplied ? `Waiting on your reply · ${ago}` : `Read, not answered · ${ago}` };
    else if (person && unread) item = { tier: 2, kind: "unread", reason: `Unread from ${senderLabel(t)} · ${ago}` };
    else if (c.security) item = { tier: 3, kind: "security", reason: `Security alert from ${senderLabel(t)} · ${ago}` };
    if (item) out.push({ tier: item.tier, item: { key: `${t.connectionId}:${t.threadKey}`, kind: item.kind, reason: item.reason, thread: t } });
  }
  for (const [domain, list] of failures) {
    if (list.length < r.exclusions.bot_failure_repeat) continue;
    const latest = [...list].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
    if (!latest) continue;
    out.push({ tier: 4, item: { key: `failures:${domain}`, kind: "repeated_failures", reason: `${String(list.length)} failure alerts from ${domain}`, thread: latest, count: list.length } });
  }
  out.sort((a, b) => a.tier - b.tier || a.item.thread.receivedAt.localeCompare(b.item.thread.receivedAt));
  return { top: out.slice(0, limit).map((o) => o.item), more: Math.max(0, out.length - limit) };
}

const MONEY_ORDER: MoneyKind[] = ["failed_payment", "invoice", "bill", "renewal"];

/**
 * Money card: invoices, bills, renewals and failed payments by subject pattern (failed payments first). Money mail is
 * usually bulk or machine-generated (billing systems), so a match is kept despite the bulk, auto-generated, label and
 * bot_subject exclusions. Still left out: one-time codes, calendar notices, true auto-replies and the newsletter sender lists.
 */
export function moneyThreads(rows: ThreadRow[], r: AttentionRules, limit = 6): MoneyThread[] {
  const out: MoneyThread[] = [];
  for (const t of rows) {
    if (t.lastIsOwner) continue; // already answered
    const kind = MONEY_ORDER.find((k) => subjectHas(t.subject, r.money[k]));
    if (!kind) continue;
    const c = classify(t, r);
    // A subject-prefix-only calendar/auto-reply match is soft: an authenticated priority sender skips it.
    if ((c.excluded === "otp" || c.excluded === "calendar" || c.excluded === "auto_reply") && !(isTrustedPriority(t, r) && !c.hard)) continue;
    if (senderHas(t.fromAddress, r.exclusions.newsletter_senders) || senderHas(t.fromAddress, r.exclusions.org_newsletter_senders)) continue;
    // Spam and trash are never money (T-234 part 2 security re-check M2).
    if (t.labels.some((l) => /^(spam|trash)$/i.test(l))) continue;
    // A money subject overrides the bulk / generated / label / bot exclusions only for an AUTHENTICATED sender (real billing
    // systems sign with DKIM aligned to their From domain); unauthenticated "Invoice overdue, pay here" mail stays out.
    if (c.excluded !== null && t.isAuthPass !== true) continue;
    out.push({ key: `${t.connectionId}:${t.threadKey}`, kind, thread: t });
  }
  return out.sort((a, b) => MONEY_ORDER.indexOf(a.kind) - MONEY_ORDER.indexOf(b.kind) || b.thread.receivedAt.localeCompare(a.thread.receivedAt)).slice(0, limit);
}


/** Parses core.briefing_threads rows. */
export function parseThreads(data: unknown): ThreadRow[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((r: Record<string, unknown>) => {
    if (typeof r.connection_id !== "string" || typeof r.thread_key !== "string" || typeof r.message_id !== "string" || typeof r.received_at !== "string") return [];
    const at = Date.parse(r.received_at);
    if (Number.isNaN(at)) return [];
    const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return [
      {
        connectionId: r.connection_id,
        threadKey: r.thread_key,
        messageId: r.message_id,
        fromAddress: str(r.from_address)?.toLowerCase() ?? null,
        fromName: str(r.from_name),
        subject: str(r.subject),
        receivedAt: new Date(at).toISOString(),
        sourceUrl: httpsUrl(r.source_url),
        labels: Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === "string") : [],
        isImportant: r.is_important === true,
        lastIsOwner: r.last_is_owner === true,
        ownerReplied: r.owner_replied === true,
        unreadCount: num(r.unread_count),
        inboundCount: num(r.inbound_count),
        isBulk: r.is_bulk === true,
        isCalendar: r.is_calendar === true,
        isAuto: r.is_auto === true,
        isGenerated: r.is_generated === true,
        isAuthPass: r.is_auth_pass === true,
      },
    ];
  });
}

/**
 * Subjects shown on Home with figures masked: money amounts become "[amount]" and long digit runs (account, card or
 * reference numbers) "[number]". Figures on Home come only from SQL (rule 7); a subject is sender-written text.
 */
export function maskFigures(subject: string): string {
  return subject
    .replace(/(?:[$€£¥]|usd|eur|gbp)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d{2})\s?(?:usd|eur|gbp|dollars)?/gi, "[amount]")
    .replace(/\d{4,}/g, "[number]");
}
