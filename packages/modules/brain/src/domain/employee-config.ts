// Employee config (T-211, spec §3): the strict schema of brain.employees.config, the action-type mapping table and the
// permission ceiling. Pure and client-safe. Company settings (mailboxes, KPIs, policies) come in as arguments read from
// lane_config / lane_policies by the caller; nothing company-specific is in this file.
import { z } from "zod";
import { ACTION_TYPES, KPI_IDS, email, hhmm, laneCode } from "@nichols/core/lane-config";

export type ActionType = (typeof ACTION_TYPES)[number];

const sender = z.union([email, z.string().regex(/^@[a-z0-9.-]+\.[a-z]{2,}$/)]); // same shape as lane_config.priority_senders

// Owner-written free text that reaches prompts later: no control characters (same rule as lane_config tags; review L5).
const plainText = (max: number) => z.string().max(max).regex(/^[^\u0000-\u001f\u007f]*$/);
const unique = <T>(a: readonly T[]) => new Set(a).size === a.length;
const ianaZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const DEFAULT_SCHEDULE_DAYS = [1, 2, 3, 4, 5] as const; // Mon-Fri, 0 = Sunday (D-32)

export const employeeConfigSchema = z.strictObject({
  timezone: z.string().min(1).max(64).refine(ianaZone, "not an IANA time zone").default("America/New_York"),
  lanes: z.array(laneCode).min(1).max(10),
  sources: z
    .strictObject({
      mail: z
        .array(
          z.strictObject({
            lane: laneCode,
            mailbox: email,
            priority: z.int().min(1).max(9),
            include: z.array(plainText(200)).max(20).default([]),
          }),
        )
        .max(30)
        .default([]),
      vip_senders: z.array(sender).max(50).default([]),
      calendar: z.strictObject({ days_ahead: z.int().min(0).max(14).default(7) }).prefault({}),
      finance_alerts: z.boolean().default(true),
      finance_kpis: z.array(z.enum(KPI_IDS)).max(KPI_IDS.length).default([]),
      approvals_pending: z.boolean().default(true),
      external: z.array(z.strictObject({ kind: z.enum(["web_news"]), topics: z.array(plainText(100)).max(10) })).max(5).default([]),
    })
    .prefault({}),
  exclude: z.array(z.enum(["newsletters", "promotions", "social", "automated"])).refine(unique).default(["newsletters", "promotions", "social", "automated"]),
  schedule: z
    .strictObject({
      time: hhmm.optional(),
      days: z.array(z.int().min(0).max(6)).min(1).max(7).refine(unique).default([...DEFAULT_SCHEDULE_DAYS]),
    })
    .prefault({}),
  output: z
    .strictObject({
      max_attention_items: z.int().min(1).max(10).default(5),
      max_drafts: z.int().min(0).max(5).default(3),
      target_words: z.int().min(150).max(1200).default(500),
      sections: z
        .array(z.enum(["coverage", "attention", "calendar", "deadlines", "money", "finance_kpis", "approvals", "news", "priorities", "drafts", "clarifications"]))
        .default(["coverage", "attention", "calendar", "deadlines", "finance_kpis", "approvals", "priorities", "drafts", "clarifications"]),
    })
    .prefault({}),
  delivery: z.array(z.enum(["in_app", "push"])).min(1).refine(unique).default(["in_app", "push"]),
  // The `email.draft` alias is stored as `email.save_draft`, deduplicated (review L1), so readers compare one spelling.
  permissions: z
    .strictObject({
      propose: z
        .array(z.enum(ACTION_TYPES))
        .max(ACTION_TYPES.length)
        .transform((a) => [...new Set(a.map((t) => (t === "email.draft" ? "email.save_draft" : t)))])
        .default(["email.save_draft"]),
    })
    .prefault({}),
});

export type EmployeeConfig = z.infer<typeof employeeConfigSchema>;

// ---- Action-type mapping table (spec §3 "Action-type vocabulary") ----

export type PolicyAction = "email_draft" | "email_send" | "calendar" | "monday" | "notion";
export type ApprovalsActionType = "email.save_draft" | "email.send" | "calendar.event" | "monday.item" | "notion.page";

/** One row per `ACTION_TYPES` value: config spelling -> lane_policies.write_actions_allowed spelling -> approvals action type. */
export const ACTION_TYPE_MAP: Readonly<Record<ActionType, Readonly<{ policy: PolicyAction; approvals: ApprovalsActionType; email: boolean }>>> = Object.freeze({
  "email.save_draft": { policy: "email_draft", approvals: "email.save_draft", email: true },
  "email.draft": { policy: "email_draft", approvals: "email.save_draft", email: true }, // alias of email.save_draft
  "email.send": { policy: "email_send", approvals: "email.send", email: true },
  "calendar.event": { policy: "calendar", approvals: "calendar.event", email: false },
  "monday.item": { policy: "monday", approvals: "monday.item", email: false },
  "notion.page": { policy: "notion", approvals: "notion.page", email: false },
});
for (const row of Object.values(ACTION_TYPE_MAP)) Object.freeze(row);

/** Roles that may have an employee propose writes. Only the owner approves (approvals spec §8) and runs an employee (§3). */
export const PROPOSING_ROLES: readonly string[] = Object.freeze(["owner"]);

export type DeniedReason = "unknown_type" | "role" | "lane_policy" | "drafts_not_stored";
export type EffectivePermissions = {
  /** Approvals action types the employee may propose, deduplicated. */
  allowed: ApprovalsActionType[];
  /** Config entries that have no effect, shown as "not allowed in this lane". */
  denied: { type: ActionType; reason: DeniedReason }[];
};

/**
 * Effective permission = config.permissions.propose ∩ lane_policies.write_actions_allowed ∩ role. The profile can only
 * narrow what the lane allows, never widen it. Email proposals also need lane_policies.store_outbound_drafts (D-19).
 * Unknown policy entries and unknown roles grant nothing (fail closed). `policy` and `role` are those of the lane the
 * proposal targets: for a multi-lane employee use effectivePermissionsByLane, never the home lane's for every lane.
 */
export function effectivePermissions(
  propose: readonly ActionType[],
  policy: { write_actions_allowed: readonly string[]; store_outbound_drafts: boolean },
  role: string,
): EffectivePermissions {
  const allowed = new Set<ApprovalsActionType>();
  const denied: EffectivePermissions["denied"] = [];
  for (const type of new Set(propose)) {
    const row = Object.hasOwn(ACTION_TYPE_MAP, type) ? ACTION_TYPE_MAP[type] : undefined;
    if (row === undefined) denied.push({ type, reason: "unknown_type" });
    else if (!PROPOSING_ROLES.includes(role)) denied.push({ type, reason: "role" });
    else if (!policy.write_actions_allowed.includes(row.policy)) denied.push({ type, reason: "lane_policy" });
    else if (row.email && !policy.store_outbound_drafts) denied.push({ type, reason: "drafts_not_stored" });
    else allowed.add(row.approvals);
  }
  return { allowed: [...allowed], denied };
}

/** Effective permissions per lane of a multi-lane employee: each lane's own policy and the owner's role in that lane (review M3). */
export function effectivePermissionsByLane(
  propose: readonly ActionType[],
  lanes: readonly string[],
  policyFor: (lane: string) => { write_actions_allowed: readonly string[]; store_outbound_drafts: boolean },
  roleFor: (lane: string) => string,
): Record<string, EffectivePermissions> {
  const out: Record<string, EffectivePermissions> = {};
  for (const lane of lanes) out[lane] = effectivePermissions(propose, policyFor(lane), roleFor(lane));
  return out;
}

// ---- Cross-checks against lane_config (the config only selects from what a lane can connect) ----

/** What the caller read from `lane_config` for one lane. */
export type LaneSettings = { mailboxes: readonly string[]; kpis: readonly string[] };
export type ConfigIssueCode = "schema" | "lane_not_available" | "lanes_mismatch" | "lanes_duplicate" | "mail_lane_not_in_lanes" | "mailbox_unknown" | "kpi_not_in_lane";
export type ConfigIssue = { code: ConfigIssueCode; path: string };
export type ConfigCheck = { ok: true; config: EmployeeConfig } | { ok: false; issues: ConfigIssue[] };

/**
 * Parses an employee config and checks it against the lane settings. `settingsFor(lane)` returns null for a lane the user
 * cannot open or that is not enabled. Issues carry a code and a path only, never the submitted values.
 */
export function checkEmployeeConfig(input: unknown, laneId: string, settingsFor: (lane: string) => LaneSettings | null): ConfigCheck {
  const parsed = employeeConfigSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ code: "schema" as const, path: i.path.join(".") })) };
  const c = parsed.data;
  const issues: ConfigIssue[] = [];
  if (new Set(c.lanes).size !== c.lanes.length) issues.push({ code: "lanes_duplicate", path: "lanes" });
  if (c.lanes.length === 1 && c.lanes[0] !== laneId) issues.push({ code: "lanes_mismatch", path: "lanes" }); // single-lane: lanes == [lane_id]
  const settings = new Map<string, LaneSettings>();
  c.lanes.forEach((lane, i) => {
    const s = settingsFor(lane);
    if (s === null) issues.push({ code: "lane_not_available", path: `lanes.${String(i)}` });
    else settings.set(lane, s);
  });
  c.sources.mail.forEach((m, i) => {
    const s = settings.get(m.lane);
    if (!c.lanes.includes(m.lane)) {
      issues.push({ code: "mail_lane_not_in_lanes", path: `sources.mail.${String(i)}.lane` });
      return;
    }
    if (!s) return;
    const match = s.mailboxes.find((b) => b.toLowerCase() === m.mailbox.toLowerCase());
    if (match === undefined) issues.push({ code: "mailbox_unknown", path: `sources.mail.${String(i)}.mailbox` });
    else m.mailbox = match; // store lane_config's spelling, so later exact matches cannot drift (review L6)
  });
  // finance_kpis ⊆ lane_config.kpis: a KPI must be configured in at least one lane the employee reads; [] = all of each lane's KPIs.
  const available = new Set([...settings.values()].flatMap((s) => [...s.kpis]));
  c.sources.finance_kpis.forEach((k, i) => {
    if (!available.has(k)) issues.push({ code: "kpi_not_in_lane", path: `sources.finance_kpis.${String(i)}` });
  });
  return issues.length === 0 ? { ok: true, config: c } : { ok: false, issues };
}

/**
 * The KPIs an employee may compute for one lane: its finance_kpis that this lane's lane_config.kpis lists, or all of the
 * lane's KPIs when finance_kpis is empty. Never a KPI configured only in another lane (review M3).
 */
export function kpisForLane(config: Pick<EmployeeConfig, "sources">, lane: LaneSettings): string[] {
  const wanted = config.sources.finance_kpis;
  return wanted.length === 0 ? [...lane.kpis] : wanted.filter((k) => lane.kpis.includes(k));
}
