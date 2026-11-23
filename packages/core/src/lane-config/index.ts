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
/** A lower-case DNS domain name (a mail account domain), at least two labels, no scheme, port, path or wildcard. */
export const mailDomain = z.string().max(253).regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/);
const ids = z.array(id).max(500).default([]);
/** Free-text labels (GoHighLevel tags, pipeline stage names): any printable text, no control characters. */
const tags = z.array(z.string().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/)).max(500).default([]);
/** Case-insensitive substring patterns (briefing rules): plain text, never a regular expression. */
const prefixPatterns = z
  .array(z.string().min(4).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).refine((v) => v.trim().endsWith(":"), "a subject prefix must end with a colon"))
  .max(100)
  .describe("subject prefixes: at least 4 characters, ending with a colon");
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
  // T-278: the Messages page (Microsoft Teams). A limited lane shows it only when it lists `messages`; whether Teams works is `teams.enabled`.
  "messages",
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

/** GovCon news card (T-234 part 4). The six topics are generic government-contracting subjects, not company data. */
export const DEFAULT_NEWS_TOPICS = [
  "FAR and DFARS changes",
  "CMMC (cybersecurity maturity model certification)",
  "GSA and SAM.gov updates",
  "small-business contracting",
  "major bid protests and contract awards",
  "federal IT acquisition",
] as const;
/** Official sources the prompt prefers (a preference only: trade press is allowed, nothing is restricted by domain). */
export const DEFAULT_NEWS_PREFERRED_DOMAINS = ["acquisition.gov", "federalregister.gov", "gsa.gov", "sam.gov", "defense.gov"] as const;
const hostname = z.string().max(253).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/);
const newsTopic = z.string().min(3).max(120).regex(/^[^\u0000-\u001f\u007f<>]+$/);

export const newsSchema = z
  .strictObject({
    // Off unless true. It also needs the `web` category in lane_policies.llm_allowed_categories (a human SQL step in production).
    enabled: z.boolean().default(false),
    // The daily fetch time (America/New_York wall clock); the job fetches once per day from this time on.
    time: hhmm.default("06:00"),
    topics: z.array(newsTopic).min(1).max(10).default([...DEFAULT_NEWS_TOPICS]),
    preferred_domains: z.array(hostname).max(20).default([...DEFAULT_NEWS_PREFERRED_DOMAINS]),
    // Never used with an allow list (the API refuses both together; trade press must stay allowed).
    blocked_domains: z.array(hostname).max(64).default([]),
    // Searches per fetch (the API's max_uses).
    max_searches: z.int().min(1).max(10).default(6),
    // T-236: the model's output limit for one news call (thinking and the cited answer count toward it). A reply cut off at this
    // limit is never parsed: it is retried once with 1.5x the limit and fewer stories, then recorded as output_truncated.
    max_tokens: z.int().min(2000).max(32000).default(8000),
    // Spend guard (USD, estimate): a fetch is refused before the model call when month-to-date plus the worst case for one call exceeds it.
    monthly_cap_usd: z.number().min(1).max(1000).default(20),
    // Prices for the estimate. NOT verified against the vendor price list (backlog Needs human): check before relying on the cap.
    cost_per_1000_searches_usd: z.number().min(0).max(1000).default(10),
    input_usd_per_mtok: z.number().min(0).max(1000).default(3),
    output_usd_per_mtok: z.number().min(0).max(1000).default(15),
  })
  .prefault({});

/** Mail and calendar providers a lane can have (microsoft spec §4, D-57: a lane may enable both at once, permanently). */
export const MAIL_PROVIDERS = ["google", "microsoft"] as const;
export const mailProviderSchema = z.enum(MAIL_PROVIDERS);
/** A raw calendar id (Google or Graph): printable, no controls or whitespace, at most 200 characters. */
const calendarId = z.string().regex(/^[^\s\u0000-\u001f\u007f-\u009f]{1,200}$/);
/** The enabled providers of a lane (T-269): 1..2 entries, unique. */
const mailProvidersList = z
  .array(mailProviderSchema)
  .min(1)
  .max(MAIL_PROVIDERS.length)
  .refine((a) => new Set(a).size === a.length, "providers must be unique");
/**
 * The provider keys of the `mail` section, shared by the whole config and the reader's narrow view. `providers` is the list
 * (default `["google"]`); `provider` is the deprecated T-250 single value, accepted as input only (read as `[provider]` when
 * `providers` is absent, refused when both are present) and never present in the parsed output, so every config version the app
 * writes carries `providers` only.
 */
const mailProviderKeys = { provider: mailProviderSchema.optional(), providers: mailProvidersList.optional() };
function resolveMailProviders<T extends { provider?: (typeof MAIL_PROVIDERS)[number]; providers?: (typeof MAIL_PROVIDERS)[number][] }>(
  m: T,
  ctx: z.RefinementCtx,
): Omit<T, "provider" | "providers"> & { providers: (typeof MAIL_PROVIDERS)[number][] } {
  const { provider, providers, ...rest } = m;
  if (provider !== undefined && providers !== undefined) {
    ctx.addIssue({ code: "custom", message: "mail.provider and mail.providers are both set; use mail.providers only", path: ["providers"] });
  }
  return { ...rest, providers: providers ?? (provider !== undefined ? [provider] : ["google"]) };
}
export const MICROSOFT_CLOUDS = ["commercial", "gcc_high"] as const;
export const MICROSOFT_MAIL_FOLDERS = ["inbox", "sentitems", "archive"] as const;
export const DEFAULT_MICROSOFT_MAIL_FOLDERS = ["inbox", "sentitems"] as const;
const lowerUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "must be a lower-case UUID");
// Never a company tenant: Microsoft's fixed tenant for personal accounts (outlook.com and the like) and the nil UUID. Listing
// either would let accounts connect that no company owns, so the schema refuses them (the connect flow checks again).
export const NON_ORGANIZATION_TENANT_IDS: readonly string[] = ["9188040d-6c67-4c5b-b112-36a304b66dad", "00000000-0000-0000-0000-000000000000"];

/**
 * Microsoft 365 settings of a lane (T-250, docs/specs/microsoft.md §4, §5.4, §8.1). Decisions:
 *  - `tenant_ids` are the Entra tenant ids allowed to connect, compared later with a token's `tid` claim. A stored config must be exactly
 *    what is compared, so upper-case UUIDs are REFUSED (not silently lower-cased) and duplicates are refused (also in `mail_folders`).
 *  - `allow_gcc` stays false until a human decides D-49; `mail_folders` are the well-known folders synced (drafts, junk and deleted
 *    items are never synced; custom folders are not supported).
 *  - A `microsoft` block without `microsoft` in `mail.providers` is ALLOWED: a lane prepared before use, or with Microsoft paused after use (D-57).
 *  - `calendar_ids` (T-269) are raw Graph calendar ids and replace the default selection for Microsoft connections only; the
 *    Google list stays `calendar.calendar_ids` (D-26). One list per provider, because a shared list would leave the other provider's
 *    connections with no calendar.
 */
export const microsoftSchema = z.strictObject({
  cloud: z.enum(MICROSOFT_CLOUDS).default("commercial"),
  tenant_ids: z
    .array(lowerUuid.refine((id) => !NON_ORGANIZATION_TENANT_IDS.includes(id), "must be an organisation's tenant id"))
    .min(1)
    .max(10)
    .refine((a) => new Set(a).size === a.length, "tenant_ids must be unique"),
  allow_gcc: z.boolean().default(false),
  mail_folders: z
    .array(z.enum(MICROSOFT_MAIL_FOLDERS))
    .min(1)
    .max(3)
    .refine((a) => new Set(a).size === a.length, "mail_folders must be unique")
    .default([...DEFAULT_MICROSOFT_MAIL_FOLDERS]),
  calendar_ids: z
    .array(calendarId)
    .min(1)
    .max(5)
    .refine((a) => new Set(a).size === a.length, "calendar_ids must be unique")
    .optional(),
});
export type MicrosoftConfig = z.infer<typeof microsoftSchema>;

/**
 * Microsoft Teams settings of a lane (T-278, docs/specs/messages.md 4.3; decision D-66). Independent of `mail.providers` and of the `microsoft` block (D-62): a lane with
 * Google mail only can have Teams, and so can one with Microsoft mail or none. Same strictness as `microsoft`: lower-case tenant ids (never the personal-account or nil
 * tenant), unique lists, no unknown key. `enabled` defaults to false: Teams is off for every lane until a human version of the config sets it. `cloud` accepts `gcc_high`
 * so the value can be stored, but the guard refuses it until a GCC High Teams task exists (spec section 15). `allowed_domains` must be listed (empty refuses: fail closed).
 * `chat_send` needs `chat_read`, `channels_send` needs `channels_read` (a person cannot send where they cannot read).
 */
export const TEAMS_FEATURES = ["chat_read", "chat_send", "call_links", "channels_read", "channels_send"] as const;
export type TeamsFeature = (typeof TEAMS_FEATURES)[number];
export const teamsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  cloud: z.enum(MICROSOFT_CLOUDS).default("commercial"),
  tenant_ids: z
    .array(lowerUuid.refine((id) => !NON_ORGANIZATION_TENANT_IDS.includes(id), "must be an organisation's tenant id"))
    .min(1)
    .max(10)
    .refine((a) => new Set(a).size === a.length, "tenant_ids must be unique"),
  allowed_domains: z
    .array(mailDomain)
    .min(1)
    .max(20)
    .refine((a) => new Set(a).size === a.length, "allowed_domains must be unique"),
  features: z
    .array(z.enum(TEAMS_FEATURES))
    .min(1)
    .max(TEAMS_FEATURES.length)
    .refine((a) => new Set(a).size === a.length, "features must be unique")
    .refine((a) => !a.includes("chat_send") || a.includes("chat_read"), "chat_send needs chat_read")
    .refine((a) => !a.includes("channels_send") || a.includes("channels_read"), "channels_send needs channels_read")
    .default(["chat_read"]),
});
export type TeamsConfig = z.infer<typeof teamsSchema>;
/** Only the `teams` key of a config, for the reader that must not depend on unrelated settings (other root keys are ignored). */
export const teamsViewSchema = z.object({ teams: teamsSchema.optional() });

/** The cross-field rules of the provider settings; used by the whole config and by the reader's narrow view (one definition). */
export function refineMailProviders(c: { mail?: { providers: (typeof MAIL_PROVIDERS)[number][] }; mail_transport?: string; microsoft?: unknown }, ctx: z.RefinementCtx): void {
  const providers = c.mail?.providers ?? ["google"];
  if (providers.includes("microsoft") && c.microsoft === undefined) {
    ctx.addIssue({ code: "custom", message: "microsoft settings are required when microsoft is in mail.providers", path: ["microsoft"] });
  }
  // mail_transport is about how Google is reached; Microsoft connections are always native (spec §4).
  if (c.mail_transport === "composio" && !providers.includes("google")) {
    ctx.addIssue({ code: "custom", message: "mail_transport composio needs google in mail.providers", path: ["mail_transport"] });
  }
}

/**
 * Only the provider-related keys of a config (other root keys are ignored), for readers that must not depend on unrelated settings.
 * The `mail` section itself is strict: its other two keys are accepted unvalidated, and any unknown key (a mistyped `Providers`)
 * is refused, because a typo there would otherwise read as the default `["google"]` and keep Google enabled without an error.
 */
export const mailProviderViewSchema = z
  .object({
    mail: z
      .strictObject({ ...mailProviderKeys, allowed_domains: z.unknown().optional(), self_connect_domains: z.unknown().optional() })
      .transform(resolveMailProviders)
      .prefault({}),
    mail_transport: z.enum(["native", "composio"]).default("native"),
    microsoft: microsoftSchema.optional(),
  })
  .superRefine(refineMailProviders);

export const laneConfigSchema = z.strictObject({
  enabled_modules: z.array(z.enum(MODULES)).default([]),
  // T-265: false (the default, and every stored lane today) = the app shows every module whatever `enabled_modules` lists (the list was
  // never read before, so an older lane's list may be incomplete). true = the app shows ONLY the listed modules: navigation, Home and
  // Settings drop the rest (see `moduleVisible`). A mail-only lane sets it; nothing else about a lane changes by flipping it.
  limit_to_enabled_modules: z.boolean().default(false),
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
  // Retired (T-197): `connection_test_enabled` used to show the temporary connection-test section (T-198). Nothing reads it any
  // more (Check connection is part of Settings -> Connections for the connect roles). The key stays only so a stored config that
  // still holds it parses; remove it when no stored version has it.
  pilot: z.strictObject({ connection_test_enabled: z.boolean().default(false) }).optional(),
  mailboxes: z.array(email).max(20).default([]),
  // Which Google accounts may be connected to this lane (T-247). Fail closed: an empty list allows no account.
  //  - allowed_domains: lower-case domains of the Google Workspace accounts that may be connected (e.g. the company's own domains).
  //    Checked at connect and on every Google call, in addition to D-23 (one account, one lane).
  //  - mailboxes (above): an OPTIONAL exact-address list. When it is not empty the address must be in BOTH lists (the list narrows the
  //    domain rule, it never widens it); when it is empty the domain list alone decides.
  //  - self_connect_domains: domains whose accounts a user may connect themselves through the later Composio route (e.g. a personal
  //    gmail.com, after H-041). Nothing reads it yet; it stays empty.
  mail: z
    .strictObject({
      // Which providers this lane's mail and calendar use (T-269, D-57): 1..2, default ["google"] (nothing changes for a stored
      // lane). `provider` is the T-250 single value, accepted as input only and never emitted (see `mailProviderKeys`).
      ...mailProviderKeys,
      allowed_domains: z.array(mailDomain).max(20).default([]),
      self_connect_domains: z.array(mailDomain).max(20).default([]),
    })
    .transform(resolveMailProviders)
    .prefault({}),
  // How the lane's Gmail + Calendar are reached (T-219, D-30, D-37): `native` = our own Google OAuth client and Vault tokens
  // (the only path that syncs today, and every existing lane); `composio` = Composio holds the Google tokens (D-35). Switching
  // a lane is this one value, after the Composio path passes its live check. Default `native`: nothing changes for a lane
  // that does not set it.
  mail_transport: z.enum(["native", "composio"]).default("native"),
  // Microsoft 365 settings (T-250); required when "microsoft" is in mail.providers (refine at the end of this schema).
  microsoft: microsoftSchema.optional(),
  // Microsoft Teams (T-278, spec messages.md 4.3): its own tenants, domains and features; independent of the mail providers above.
  teams: teamsSchema.optional(),
  // Google Calendar sync (T-064). Unset = primary plus owned/writable selected calendars, 365 days ahead.
  // `calendar_ids` are raw GOOGLE calendar ids (D-26); an explicit list replaces the default selection for Google connections.
  // Microsoft calendar ids are `microsoft.calendar_ids` (T-269). `include_read_only` and `forward_days` apply to both providers.
  calendar: z
    .strictObject({
      calendar_ids: z.array(calendarId).min(1).max(10).optional(),
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
      // The AI briefing job's daily schedule (T-231c). Off unless set to true: Home still prepares a summary on its own when it is older than 3 hours (T-235).
      schedule_enabled: z.boolean().default(false),
      // T-236: the model's output limit for one briefing call (thinking counts toward it on current models). A reply cut off at
      // this limit is never parsed: it is retried once with 1.5x the limit, then recorded as output_truncated.
      max_tokens: z.int().min(2000).max(32000).default(8000),
      // A mail or calendar stream counts as stale when it last synced longer ago than this.
      coverage_stale_minutes: z.int().min(15).max(10080).default(120),
      // Domains that count as internal for "external attendees" (the lane's mailbox domains always count).
      internal_domains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(50).default([]),
      // Mail older than this is not considered for "Needs your attention".
      attention_days: z.int().min(1).max(14).default(7),
      // T-240: the top 5 holds only threads whose latest inbound message is at most this many hours old (6 hours to 7 days).
      // Older qualifying threads are counted on Home as "Still waiting" and listed in the Inbox (?view=waiting).
      attention: z.strictObject({ fresh_hours: z.int().min(6).max(168).default(48) }).prefault({}),
      // T-240: whole-word subject patterns that mark a deadline (the "Deadline" chip and importance band). Generic business words, not company data.
      deadline_subjects: patterns.default(["deadline", "due today", "due tomorrow", "by EOD", "RFP", "proposal due", "expires"]),
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
          // T-243: sign-in LINK subjects ("Your customer portal login link", "magic link") are automated like codes: a hard exclusion for everyone.
          // "sign in to" is not listed: a person writes "please sign in to the portal". An explicit list in a lane's own config replaces these defaults.
          otp_subjects: patterns.default(["verification code", "one-time code", "one-time password", "one time password", "OTP", "security code", "login code", "sign-in code", "passcode", "2FA code", "confirm your email", "login link", "log in link", "log-in link", "sign-in link", "sign in link", "signin link", "magic link", "login url", "sign-in url", "verification link"]),
          bank_alert_subjects: patterns.default(["transaction alert", "you made a purchase", "purchase alert", "debit card", "card transaction", "withdrawal", "deposit posted", "balance alert", "direct deposit"]),
          // Bank mail kept even when it matches an alert pattern.
          bank_keep_subjects: patterns.default(["statement", "payment due", "due date", "is due", "minimum payment"]),
          automated_senders: patterns.default(["no-reply", "noreply", "do-not-reply", "donotreply", "notifications", "notification", "alerts", "bounce", "mailer-daemon"]),
          // T-234 part 2. Bulk/marketing mail is recognised by its headers at sync time (List-Unsubscribe, Precedence bulk/list/junk,
          // List-Id: stored as the boolean is_bulk, never the headers). These are the org's OWN newsletter senders, which look like
          // colleagues but are bulk: same sender syntax as above ("name@", "example.com", a word). Empty by default (company data).
          org_newsletter_senders: patterns.default([]),
          // T-240. Mail from one of the lane's OWN mailbox domains (derived, never listed here) whose sender is one of these non-person
          // local parts ("name@" = exactly that local part) is bulk even without a header flag (older rows). A colleague is never matched.
          own_domain_bulk_senders: patterns.default(["no-reply@", "noreply@", "do-not-reply@", "donotreply@", "newsletter@", "newsletters@", "news@", "updates@", "info@", "marketing@", "announcements@", "digest@"]),
          // Calendar invitations and updates: text/calendar mail is flagged at sync (is_calendar); these subject PREFIXES (case-insensitive,
          // at the start of the subject, so "Re: Invitation: ..." from a person is not caught) cover mail whose parts are not visible.
          calendar_subjects: prefixPatterns.default(["Invitation:", "Updated invitation:", "Updated invitation with note:", "Canceled event:", "Cancelled event:", "Canceled:", "Accepted:", "Declined:", "Tentatively accepted:", "New event:"]),
          // True auto-replies are recognised by Auto-Submitted: auto-replied, X-Autoreply / X-Autorespond and Precedence auto_reply at sync
          // (is_auto: a hard exclusion); these subject PREFIXES (>= 4 characters, ending with ":") catch the rest. A subject-prefix-only
          // match is a SOFT exclusion: a priority sender whose mail passed authentication skips it ("Canceled: PO 4471").
          auto_reply_subjects: prefixPatterns.default(["Automatic reply:", "Auto-reply:", "Autoreply:", "Auto reply:", "Out of office:", "Out of Office Autoreply:", "Automatic response:"]),
          // Bot/CI subjects (whole words). Applied only to automated senders (no-reply, notifications ... or bot_senders), never to a person.
          bot_subjects: patterns.default(["[github]", "dependabot", "pull request", "workflow run", "build #", "pipeline #", "deployment ready", "preview deployment", "check suite"]),
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
      // T-286, D-67 (open): the authenticator window for `teams.*` sends only (email keeps step_up_max_age_s). 300 = the same as email until the owner decides; the database clamps to 300..43,200.
      teams_step_up_max_age_s: z.int().min(300).max(43200).default(300),
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
      // action.reconcile_stuck (T-192): an action still `executing` after this many minutes is looked up at the provider;
      // undecidable ones end failed / outcome_unknown after the give-up time (at least the first number + 5).
      reconcile_after_minutes: z.int().min(5).max(1440).default(10),
      reconcile_give_up_minutes: z.int().min(10).max(2880).default(60),
      allowed_mailboxes: z.array(email).max(20).default([]),
      monday_column_allowlist: ids,
    })
    .refine((a) => a.reconcile_give_up_minutes >= a.reconcile_after_minutes + 5, {
      message: "reconcile_give_up_minutes must be at least reconcile_after_minutes + 5",
      path: ["reconcile_give_up_minutes"],
    })
    .prefault({}),
  news: newsSchema,
  assistant: z
    .strictObject({
      messages_per_hour: z.int().min(1).max(1000).default(30),
      messages_per_day: z.int().min(1).max(10000).default(200),
      max_snippet_chars: z.int().min(50).max(1000).default(300), // assistant spec §6
    })
    .prefault({}),
}).superRefine(refineMailProviders);

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

/** A module of a lane (the `enabled_modules` vocabulary). */
export type LaneModule = (typeof MODULES)[number];

/**
 * Whether the app shows a module for a lane (T-265). Pure, from the stored config row. A lane that does not set
 * `limit_to_enabled_modules: true` shows every module (unchanged behaviour). A limited lane shows exactly the listed modules.
 * Anything that is not a readable object, or a malformed `limit_to_enabled_modules`, reads as NOT limited: this only hides
 * screens, it never grants access (every read is still gated by RLS).
 */
export function moduleVisible(config: unknown, module: LaneModule): boolean {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return true;
  const c = config as Record<string, unknown>;
  if (c.limit_to_enabled_modules !== true) return true;
  return Array.isArray(c.enabled_modules) && c.enabled_modules.includes(module);
}
