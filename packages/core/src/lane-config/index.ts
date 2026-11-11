// Per-lane source settings (T-011), stored as versioned jsonb rows in core.lane_config. Company settings live here,
// never in code (CLAUDE.md rule 2). No secrets: credentials live in env or the Vault. Every object is strict (unknown
// keys rejected), and every string value is scanned with the env secret-pattern list; the database repeats the check.
// Defaults are the values in docs/specs (finance §4.5 and §9, approvals §4 and §6, assistant §5).
import { z } from "zod";
import { looksLikeSecretValue } from "../secrets/index";

/** Shared with the brain module's employee config (exported, not copied). */
export const laneCode = z.string().regex(/^[A-Z]{1,8}$/);
const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/);
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/); // America/New_York wall-clock time
export const email = z.email().max(254);
const ids = z.array(id).max(500).default([]);
/** Free-text labels (GoHighLevel tags, pipeline stage names): any printable text, no control characters. */
const tags = z.array(z.string().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/)).max(500).default([]);
/** Case-insensitive substring patterns (briefing rules): plain text, never a regular expression. */
const patterns = z.array(z.string().min(2).max(100).regex(/^[^\u0000-\u001f\u007f]+$/)).max(100);
/** Nesting beyond this is never a valid config; the scan refuses it instead of recursing. */
const MAX_DEPTH = 16;

export const KPI_IDS = [
  "cash_book_balance",
  "ar_total",
  "ar_over_30",
  "ap_due_14d",
  "pnl_mtd",
  "pnl_ytd",
  "mrr",
  "revenue_churn_pct",
  "customer_churn_pct",
  "paid_subscribers",
  "subscribers_new_week",
  "subscribers_cancelled_week",
  "controls",
] as const;

export const MODULES = [
  "finance",
  "approvals",
  "assistant",
  "briefing",
  "comms",
  "calendar",
  "documents",
  "projects",
  "commitments",
  "memory",
  "notifications",
  "brain",
] as const;

/** `email.draft` is an alias of `email.save_draft` (D-34), kept until callers move. */
export const ACTION_TYPES = ["email.save_draft", "email.draft", "email.send", "calendar.event", "monday.item", "notion.page"] as const;

/** Which source records belong to one entity (D-17, D-18). */
const entityMappingSchema = z.strictObject({
  qbo_class_ids: ids,
  qbo_customer_ids: ids, // fallback when a transaction has no class
  stripe_product_ids: ids,
  ghl_tags: tags,
  ghl_products: ids,
});

/**
 * Intuit's Account.AccountSubType enum values that denote payroll accounts (Intuit's enum, not company data). Defaults for
 * `finance.payroll.account_subtypes`; unverified spellings are on the H-034 live-check list.
 */
export const QBO_PAYROLL_SUBTYPES = ["PayrollExpenses", "PayrollTaxExpenses", "PayrollClearing", "PayrollTaxPayable", "PayrollWagePayable", "DirectDepositPayable", "CostOfLabor"] as const;

/** The `fin.report_cache` report kinds (T-052). */
export const REPORT_KINDS = ["pnl", "balance_sheet", "cash_flow", "ar_aging_summary", "ap_aging_summary"] as const;
/** Cached by default: not balance_sheet or cash_flow until D-27 is decided. */
export const DEFAULT_REPORT_KINDS = ["pnl", "ar_aging_summary", "ap_aging_summary"] as const;

/** Allowed hours between QuickBooks backup CDC polls (T-090). Divisors of 24, so slots line up with the day; default 4. */
export const QBO_SYNC_INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12] as const;
export const DEFAULT_QBO_SYNC_INTERVAL_HOURS = 4;

/** `lane_config.finance.qbo_sync`: one definition, also parsed alone by the connectors' reader so unrelated finance settings cannot stop the poll. */
export const qboSyncSchema = z
  .strictObject({ interval_hours: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(6), z.literal(8), z.literal(12)]).default(DEFAULT_QBO_SYNC_INTERVAL_HOURS) })
  .prefault({});

export const laneConfigSchema = z.strictObject({
  enabled_modules: z.array(z.enum(MODULES)).default([]),
  kpis: z.array(z.enum(KPI_IDS)).default([]),
  qbo: z
    .strictObject({
      realm_id: z.string().regex(/^\d{1,20}$/),
      // "file": the company file is the entity; "file_class": classes inside one file split entities.
      entity_mapping_mode: z.enum(["file", "file_class"]),
    })
    .optional(),
  stripe: z.strictObject({ account_id: z.string().max(64).regex(/^acct_[A-Za-z0-9]+$/), livemode: z.boolean() }).optional(),
  ghl: z
    .strictObject({
      location_id: id,
      // D-3 (open): null until decided; subscriber views return pending_definition meanwhile.
      paid_subscriber_rule: z
        .strictObject({ tags, pipeline_stage_ids: ids, product_ids: ids })
        .nullable()
        .default(null),
    })
    .optional(),
  entities: z
    .strictObject({
      own_entity: laneCode,
      by_entity: z.record(laneCode, entityMappingSchema),
      // Bank accounts with the entity that legally owns them (D-18). Shared accounts are flagged, never allocated.
      bank_accounts: z.array(z.strictObject({ qbo_account_id: id, owner_entity: laneCode })).max(200).default([]),
    })
    .refine((e) => Object.hasOwn(e.by_entity, e.own_entity), { message: "own_entity needs a mapping", path: ["own_entity"] })
    .optional(),
  // Pilot-only switches that are removed with the feature they guard. `connection_test_enabled` shows the temporary
  // "Temporary: connection test" section on Settings (T-198, until T-045 replaces it). Off unless set to true.
  pilot: z.strictObject({ connection_test_enabled: z.boolean().default(false) }).optional(),
  mailboxes: z.array(email).max(20).default([]),
  // How the lane's Gmail + Calendar are reached (T-219, D-30, D-37): `native` = our own Google OAuth client and Vault tokens
  // (the only path that syncs today, and every existing lane); `composio` = Composio holds the Google tokens (D-35). Switching
  // a lane is this one value, after the Composio path passes its live check. Default `native`: nothing changes for a lane
  // that does not set it.
  mail_transport: z.enum(["native", "composio"]).default("native"),
  // Google Calendar sync (T-064). Unset = primary plus owned/writable selected calendars, 365 days ahead.
  // `calendar_ids` are raw Google calendar ids (an explicit list replaces the default selection).
  calendar: z
    .strictObject({
      calendar_ids: z.array(z.string().regex(/^[^\s\u0000-\u001f\u007f-\u009f]{1,200}$/)).min(1).max(10).optional(),
      include_read_only: z.boolean().default(false),
      forward_days: z.int().min(7).max(730).default(365),
    })
    .optional(),
  // Retention of indexed data per table class (T-042). Comms metadata follows the lane policy's `retention_days` (PKG 90) and
  // is not repeated here. Calendar is capped at 180 days by the database (floor 30), webhook receipts have a 7-day floor.
  retention: z
    .strictObject({
      calendar_days: z.int().min(30).max(180).default(180),
      conversations_days: z.int().min(1).max(3650).default(180),
      webhook_days: z.int().min(7).max(365).default(30),
    })
    .prefault({}),
  priority_senders: z.array(z.union([email, z.string().regex(/^@[a-z0-9.-]+\.[a-z]{2,}$/)])).max(200).default([]),
  // Daily briefing (T-231). Pattern lists are case-insensitive substrings (never regular expressions). The defaults are
  // generic mail conventions, not company data; a lane replaces a list by setting it.
  briefing: z
    .strictObject({
      // D-32: 06:30 America/New_York, Mon-Fri (0 = Sunday .. 6 = Saturday, New York dates).
      time: hhmm.default("06:30"),
      days: z.array(z.int().min(0).max(6)).min(1).max(7).refine((d) => new Set(d).size === d.length, "days must be unique").default([1, 2, 3, 4, 5]),
      // The AI briefing job's daily schedule (T-231c). Off unless set to true: "Run now" on Home works either way.
      schedule_enabled: z.boolean().default(false),
      // A mail or calendar stream counts as stale when it last synced longer ago than this.
      coverage_stale_minutes: z.int().min(15).max(10080).default(120),
      // Domains that count as internal for "external attendees" (the lane's mailbox domains always count).
      internal_domains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(50).default([]),
      // Mail older than this is not considered for "Needs your attention".
      attention_days: z.int().min(1).max(14).default(7),
      // Sender patterns: "name@" = the local part exactly; "example.com" (has a dot, no @) = that domain or a subdomain;
      // a plain word = contained in the local part only (never the domain). Subject patterns match whole words.
      exclusions: z
        .strictObject({
          labels: patterns.default(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "SPAM", "TRASH"]),
          newsletter_senders: patterns.default(["newsletter", "news@", "digest", "marketing", "promo", "mailer-daemon@"]),
          social_senders: patterns.default(["linkedin.com", "facebookmail.com", "x.com", "twitter.com", "instagram.com", "pinterest.com", "youtube.com"]),
          bot_senders: patterns.default(["github.com", "gitlab.com", "circleci.com", "vercel.com", "buildkite.com", "sentry.io", "bitbucket.org", "atlassian.net"]),
          // Bot/CI mail is shown only as one item when this many failures arrive in the attention window.
          bot_failure_words: patterns.default(["failed", "failure", "error", "broken", "errored"]),
          bot_failure_repeat: z.int().min(2).max(50).default(3),
          otp_subjects: patterns.default(["verification code", "one-time code", "one-time password", "one time password", "OTP", "security code", "login code", "sign-in code", "passcode", "2FA code", "confirm your email"]),
          bank_alert_subjects: patterns.default(["transaction alert", "you made a purchase", "purchase alert", "debit card", "card transaction", "withdrawal", "deposit posted", "balance alert", "direct deposit"]),
          // Bank mail kept even when it matches an alert pattern.
          bank_keep_subjects: patterns.default(["statement", "payment due", "due date", "is due", "minimum payment"]),
          automated_senders: patterns.default(["no-reply", "noreply", "do-not-reply", "donotreply", "notifications", "notification", "alerts", "bounce", "mailer-daemon"]),
        })
        .prefault({}),
      security_subjects: patterns.default(["new sign-in", "new sign in", "security alert", "critical vulnerability", "suspicious", "unusual sign-in", "password was changed", "password changed"]),
      // Security alerts count only from these sender domains (a subject alone is sender-controlled and could be phishing).
      security_senders: patterns.default(["google.com", "microsoft.com", "apple.com", "github.com", "okta.com", "intuit.com", "stripe.com", "1password.com"]),
      money: z
        .strictObject({
          invoice: patterns.default(["invoice"]),
          bill: patterns.default(["bill is ready", "amount due", "payment due", "statement is ready", "your bill"]),
          renewal: patterns.default(["renewal", "renews", "will renew", "subscription will", "expires soon"]),
          failed_payment: patterns.default(["payment failed", "failed payment", "payment declined", "card declined", "past due", "unable to process", "overdue"]),
        })
        .prefault({}),
    })
    .prefault({}),
  finance: z
    .strictObject({
      accounting_method: z.enum(["accrual", "cash"]).default("accrual"),
      weekly_cash_time: hhmm.default("06:00"),
      monthly_close_trigger: z.union([z.literal("manual"), z.string().regex(/^day_of_month:([1-9]|1\d|2[0-8])$/)]).default("manual"),
      // D-25 (default: payroll excluded entirely). QuickBooks transactions posted to these accounts, and accounts of these
      // subtypes, are never stored; neither are transactions that name an excluded entity (people paid as vendors,
      // D-25 follow-up for Robert). `account_subtypes` defaults to Intuit's payroll AccountSubType values.
      payroll: z
        .strictObject({
          account_ids: z.array(z.string().regex(/^\d{1,20}$/)).max(200).default([]),
          account_subtypes: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/)).max(100).default([...QBO_PAYROLL_SUBTYPES]),
          excluded_entity_ids: z.array(z.string().regex(/^\d{1,20}$/)).max(500).default([]),
        })
        .prefault({}),
      // QuickBooks report pulls (T-052). `period` is the date range of ProfitAndLoss and CashFlow (and the as-of end date
      // of BalanceSheet and the aging reports): the calendar year to date, or the last 12 months, in America/New_York.
      // The class filter comes from `entities.by_entity[own_entity].qbo_class_ids`, used only with class tracking on.
      reports: z
        .strictObject({
          period: z.enum(["year_to_date", "trailing_12_months"]).default("year_to_date"),
          // Which report kinds are fetched and cached. Default fails closed (D-27): `cash_flow` and `balance_sheet` are not
          // cached until Saurabh/Robert decide how far payroll exclusion goes, because those two let a reader recover the
          // aggregate payroll amount from the other cached reports.
          kinds: z.array(z.enum(REPORT_KINDS)).max(5).default([...DEFAULT_REPORT_KINDS]),
        })
        .prefault({}),
      // QuickBooks backup poll (T-090): webhooks are the fast path; this CDC poll catches missed ones. Hours between polls.
      qbo_sync: qboSyncSchema,
    })
    .prefault({}),
  metrics: z.strictObject({ start_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).optional(),
  controls: z
    .strictObject({
      unreconciled_over_days: z.int().min(1).max(365).default(30),
      disconnected_feed_hours: z.int().min(1).max(720).default(36),
      stripe_ghl_mismatch_threshold: z.int().min(0).max(100000).default(0),
    })
    .prefault({}),
  tieout: z.strictObject({ tolerance: z.string().regex(/^\d{1,6}\.\d{2}$/).default("0.00") }).prefault({}),
  freshness: z.strictObject({ stale_after_hours: z.int().min(1).max(720).default(36) }).prefault({}),
  approvals: z
    .strictObject({
      approvals_live: z.boolean().default(false), // humans flip it after T-170
      // Only the owner approves (approvals spec §8 test 4: viewer, finance_operator and admin_technical are denied).
      approver_roles: z.array(z.literal("owner")).min(1).default(["owner"]),
      step_up_max_age_s: z.int().min(30).max(900).default(300),
      // `email.draft` is an alias of `email.save_draft`: a legacy-only key is copied over, and two different values are
      // refused, so approvals (which use email.save_draft) always see one expiry (T-211 review M1/L3).
      expire_after_hours: z
        .partialRecord(z.enum(ACTION_TYPES), z.int().min(1).max(24 * 30))
        .refine((r) => r["email.draft"] === undefined || r["email.save_draft"] === undefined || r["email.draft"] === r["email.save_draft"], {
          message: "email.draft and email.save_draft must have the same expiry",
        })
        .transform((r) => (r["email.save_draft"] === undefined && r["email.draft"] !== undefined ? { ...r, "email.save_draft": r["email.draft"] } : r))
        .default({ "email.save_draft": 72, "email.draft": 72, "email.send": 72, "monday.item": 168 }),
      payload_retention_days: z.int().min(1).max(3650).default(30),
      allowed_mailboxes: z.array(email).max(20).default([]),
      monday_column_allowlist: ids,
    })
    .prefault({}),
  assistant: z
    .strictObject({
      messages_per_hour: z.int().min(1).max(1000).default(30),
      messages_per_day: z.int().min(1).max(10000).default(200),
      max_snippet_chars: z.int().min(50).max(1000).default(300), // assistant spec §6
    })
    .prefault({}),
});

export type LaneConfig = z.infer<typeof laneConfigSchema>;
export type LaneConfigInput = z.input<typeof laneConfigSchema>;

/**
 * Paths of string values that look like credentials, JWTs or connection strings with a password. Input nested deeper
 * than MAX_DEPTH is reported at the path where the limit was hit (never a valid config; avoids deep recursion).
 */
export function findSecretLikeValues(value: unknown, path = "$", depth = 0): string[] {
  if (typeof value === "string") return looksLikeSecretValue(value) ? [path] : [];
  if (value === null || typeof value !== "object") return [];
  if (depth >= MAX_DEPTH) return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecretLikeValues(v, `${path}[${String(i)}]`, depth + 1));
  return Object.entries(value).flatMap(([k, v]) => findSecretLikeValues(v, `${path}.${k}`, depth + 1));
}

/**
 * Validates a lane config (throws ZodError; issues carry paths, and secret findings never echo the value).
 * Use before writing a new core.lane_config version and when reading one.
 */
export function parseLaneConfig(input: unknown): LaneConfig {
  const secrets = findSecretLikeValues(input);
  if (secrets.length > 0)
    throw new z.ZodError(secrets.map((p) => ({ code: "custom", message: "secret-like value not allowed", path: [p], input: undefined })));
  return laneConfigSchema.parse(input);
}
