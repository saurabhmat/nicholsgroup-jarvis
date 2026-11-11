// "Needs your attention" and the Money card (T-231b): rules over thread METADATA (core.briefing_threads), no AI, no
// bodies. Every pattern comes from lane_config.briefing. Sender patterns are anchored ("name@" = local part, "x.com" =
// domain or subdomain, a word = in the local part); subject patterns match whole words. Order of the top list
// (acceptance order):
//   1. lane_config priority_senders (address or @domain): not subject to exclusions except one-time codes
//   2. threads waiting on the owner: last message from a real person, not the owner, and either the owner already wrote
//      in the thread or the message was read and left unanswered
//   3. unread mail from real people (not automated, not excluded)
//   4. security alerts (new sign-in, critical vulnerability, ...) from lane_config security_senders domains only
//   5. repeated bot/CI failures (one item per sender domain); within a tier, older first (age)
// Excluded before ranking: excluded labels (promotions, social, forums), newsletters, social networks, OTP codes, bank
// transaction alerts (statements and due dates are kept), single bot/CI messages.

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
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${escapeRe(lower(w))}($|[^a-z0-9])`).test(s));
}

/** Anchored sender match: "name@" = local part exactly, "x.com" = domain or a subdomain, a word = in the local part. */
export function senderHas(address: string | null | undefined, patterns: readonly string[]): boolean {
  if (!address) return false;
  const a = lower(address);
  const at = a.lastIndexOf("@");
  const local = at >= 0 ? a.slice(0, at) : a;
  const domain = at >= 0 ? a.slice(at + 1) : "";
  return patterns.some((raw) => {
    const p = lower(raw);
    if (p.endsWith("@")) return local === p.slice(0, -1);
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

export type Classified = { excluded: string | null; automated: boolean; bot: boolean; security: boolean };

/** Why a thread is left out (null = kept), and the sender class. Security alerts from trusted senders are never excluded. */
export function classify(t: ThreadRow, r: AttentionRules): Classified {
  const x = r.exclusions;
  const security = subjectHas(t.subject, r.securitySubjects) && senderHas(t.fromAddress, r.securitySenders);
  const bot = senderHas(t.fromAddress, x.bot_senders);
  const automated = bot || senderHas(t.fromAddress, x.automated_senders);
  if (security) return { excluded: null, automated, bot, security };
  let excluded: string | null = null;
  if (subjectHas(t.subject, x.otp_subjects)) excluded = "otp";
  else if (t.labels.some((l) => x.labels.some((e) => lower(e) === lower(l)))) excluded = "label";
  else if (senderHas(t.fromAddress, x.newsletter_senders)) excluded = "newsletter";
  else if (senderHas(t.fromAddress, x.social_senders)) excluded = "social";
  else if (subjectHas(t.subject, x.bank_alert_subjects) && !subjectHas(t.subject, x.bank_keep_subjects)) excluded = "bank_alert";
  else if (bot) excluded = "bot";
  return { excluded, automated, bot, security };
}

function age(iso: string, now: Date): string {
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
    const priority = isPrioritySender(t.fromAddress, r.prioritySenders);
    if (c.excluded === "bot" && !priority) {
      if (subjectHas(t.subject, r.exclusions.bot_failure_words)) {
        const k = domainOf(t.fromAddress ?? "") || "unknown";
        failures.set(k, [...(failures.get(k) ?? []), t]);
      }
      continue;
    }
    // Priority senders skip the exclusions, except one-time codes.
    if (c.excluded && !(priority && c.excluded !== "otp")) continue;
    if (t.lastIsOwner) continue; // the owner answered last: not waiting on anyone
    const unread = t.unreadCount > 0;
    const ago = age(t.receivedAt, now);
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

/** Money card: invoices, bills, renewals and failed payments by subject pattern (failed payments first); excluded mail left out. */
export function moneyThreads(rows: ThreadRow[], r: AttentionRules, limit = 6): MoneyThread[] {
  const out: MoneyThread[] = [];
  for (const t of rows) {
    const c = classify(t, r);
    // Billing systems are automated senders (kept); promotions, newsletters, OTPs, card alerts and CI mail are not money.
    if (c.excluded) continue;
    if (t.lastIsOwner) continue; // already answered
    const kind = MONEY_ORDER.find((k) => subjectHas(t.subject, r.money[k]));
    if (kind) out.push({ key: `${t.connectionId}:${t.threadKey}`, kind, thread: t });
  }
  return out.sort((a, b) => MONEY_ORDER.indexOf(a.kind) - MONEY_ORDER.indexOf(b.kind) || b.thread.receivedAt.localeCompare(a.thread.receivedAt)).slice(0, limit);
}

const https = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
};

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
        sourceUrl: https(r.source_url),
        labels: Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === "string") : [],
        isImportant: r.is_important === true,
        lastIsOwner: r.last_is_owner === true,
        ownerReplied: r.owner_replied === true,
        unreadCount: num(r.unread_count),
        inboundCount: num(r.inbound_count),
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
