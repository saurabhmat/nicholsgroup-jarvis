// "Needs your attention" and the Money card (T-231b): rules over thread METADATA (core.briefing_threads), no AI, no
// bodies. Every pattern comes from lane_config.briefing (case-insensitive substrings). Order of the top list:
//   1. lane_config priority_senders (address or @domain)
//   2. security alerts (new sign-in, critical vulnerability, ...), even from automated senders
//   3. threads waiting on the owner: the last message is not the owner's and the owner already wrote in the thread
//   4. unread mail from real people (not automated, not excluded)
//   5. repeated bot/CI failures (one item per sender), then age (older first within a tier)
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

const has = (hay: string | null | undefined, needles: readonly string[]): boolean => {
  if (!hay) return false;
  const h = hay.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
};

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

/** Why a thread is left out (null = kept), and the sender class. Security alerts are never excluded. */
export function classify(t: ThreadRow, r: AttentionRules): Classified {
  const x = r.exclusions;
  const security = has(t.subject, r.securitySubjects);
  const bot = has(t.fromAddress, x.bot_senders);
  const automated = bot || has(t.fromAddress, x.automated_senders);
  if (security) return { excluded: null, automated, bot, security };
  let excluded: string | null = null;
  if (t.labels.some((l) => x.labels.some((e) => e.toLowerCase() === l.toLowerCase()))) excluded = "label";
  else if (has(t.fromAddress, x.newsletter_senders)) excluded = "newsletter";
  else if (has(t.fromAddress, x.social_senders)) excluded = "social";
  else if (has(t.subject, x.otp_subjects)) excluded = "otp";
  else if (has(t.subject, x.bank_alert_subjects) && !has(t.subject, x.bank_keep_subjects)) excluded = "bank_alert";
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
    if (c.excluded === "bot") {
      if (has(t.subject, r.exclusions.bot_failure_words)) {
        const k = domainOf(t.fromAddress ?? "") || "unknown";
        failures.set(k, [...(failures.get(k) ?? []), t]);
      }
      continue;
    }
    if (c.excluded) continue;
    if (t.lastIsOwner) continue; // the owner answered last: not waiting on anyone
    const unread = t.unreadCount > 0;
    const ago = age(t.receivedAt, now);
    let item: { tier: number; kind: AttentionKind; reason: string } | null = null;
    if (isPrioritySender(t.fromAddress, r.prioritySenders)) item = { tier: 0, kind: "priority", reason: `Priority sender${unread ? ", unread" : ", not answered"} · ${ago}` };
    else if (c.security) item = { tier: 1, kind: "security", reason: `Security alert from ${senderLabel(t)} · ${ago}` };
    else if (!c.automated && t.ownerReplied) item = { tier: 2, kind: "waiting", reason: `Waiting on your reply · ${ago}` };
    else if (!c.automated && unread) item = { tier: 3, kind: "unread", reason: `Unread from ${senderLabel(t)} · ${ago}` };
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
    // Billing systems are automated senders (kept); promotions, newsletters, OTPs and card alerts are not money items.
    if (c.excluded && c.excluded !== "bot") continue;
    const kind = MONEY_ORDER.find((k) => has(t.subject, r.money[k]));
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
