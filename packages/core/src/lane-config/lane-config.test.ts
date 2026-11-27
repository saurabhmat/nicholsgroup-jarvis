import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTION_TYPES, email, hhmm, laneCode, findSecretLikeValues, laneConfigSchema, parseLaneConfig, QBO_PAYROLL_SUBTYPES } from "./index";

// Synthetic ids only (CLAUDE.md rule 10).
const VALID = {
  enabled_modules: ["finance", "approvals"],
  kpis: ["cash_book_balance", "ar_total", "mrr"],
  qbo: { realm_id: "1001", entity_mapping_mode: "file_class" },
  stripe: { account_id: "acct_SYNTHETIC0001", livemode: false },
  ghl: { location_id: "loc-synthetic-0001" },
  entities: {
    own_entity: "PKG",
    by_entity: {
      PKG: { qbo_class_ids: ["class-pkg"], stripe_product_ids: ["prod_SYNTHPKG"] },
      APK: { qbo_class_ids: ["class-apk"], stripe_product_ids: ["prod_SYNTHAPK"] },
    },
    bank_accounts: [{ qbo_account_id: "acct-synthetic-1", owner_entity: "PKG" }],
  },
  mailboxes: ["ops@example.test"],
  priority_senders: ["owner@example.test", "@example.test"],
};

const issuesOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof z.ZodError) return e.issues;
    throw e;
  }
  throw new Error("expected a ZodError");
};

describe("calendar section (T-064)", () => {
  it("is optional; accepts raw Google calendar ids, include_read_only and forward_days with defaults", () => {
    expect(parseLaneConfig(VALID).calendar).toBeUndefined();
    const c = parseLaneConfig({ ...VALID, calendar: { calendar_ids: ["en.usa#holiday@group.v.calendar.google.com"] } });
    expect(c.calendar).toEqual({ calendar_ids: ["en.usa#holiday@group.v.calendar.google.com"], include_read_only: false, forward_days: 365 });
  });
  it("rejects unknown keys, bad ids and out-of-range look-ahead", () => {
    for (const calendar of [{ extra: 1 }, { calendar_ids: [] }, { calendar_ids: ["a b"] }, { calendar_ids: [""] }, { calendar_ids: Array.from({ length: 11 }, (_v, i) => `c${String(i)}`) }, { forward_days: 6 }, { forward_days: 731 }, { include_read_only: "yes" }]) {
      expect(() => parseLaneConfig({ ...VALID, calendar }), JSON.stringify(calendar)).toThrow();
    }
  });
});

describe("mail_transport (T-219, D-30, D-37)", () => {
  it("defaults to native, so existing lanes are unchanged", () => {
    expect(parseLaneConfig(VALID).mail_transport).toBe("native");
    expect(parseLaneConfig({}).mail_transport).toBe("native");
  });
  it("accepts native and composio and nothing else", () => {
    expect(parseLaneConfig({ ...VALID, mail_transport: "composio" }).mail_transport).toBe("composio");
    expect(parseLaneConfig({ ...VALID, mail_transport: "native" }).mail_transport).toBe("native");
    for (const bad of ["google", "Composio", "", "microsoft", 1, null, true]) {
      expect(() => parseLaneConfig({ ...VALID, mail_transport: bad }), JSON.stringify(bad)).toThrow();
    }
  });
  it("the old name mail_provider is not accepted (strict schema)", () => {
    expect(() => parseLaneConfig({ ...VALID, mail_provider: "composio" })).toThrow();
  });
});

describe("lane config schema", () => {
  it("accepts a valid config and fills the spec defaults", () => {
    const c = parseLaneConfig(VALID);
    expect(c.finance).toEqual({ accounting_method: "accrual", weekly_cash_time: "06:00", monthly_close_trigger: "manual", payroll: { account_ids: [], account_subtypes: [...QBO_PAYROLL_SUBTYPES], excluded_entity_ids: [] }, reports: { period: "year_to_date", kinds: ["pnl", "ar_aging_summary", "ap_aging_summary"], weeks: 4, cash_history: false }, qbo_sync: { interval_hours: 4 } });
    expect(c.approvals.approvals_live).toBe(false);
    expect(c.approvals.step_up_max_age_s).toBe(300);
    expect(c.approvals.teams_step_up_max_age_s).toBe(300); // T-286, D-67 open: the same as email until the owner decides
    expect(c.approvals.expire_after_hours).toEqual({ "email.save_draft": 72, "email.draft": 72, "email.send": 72, "monday.item": 168 });
    expect(c.retention).toEqual({ calendar_days: 180, conversations_days: 180, webhook_days: 30 });
    expect(c.controls).toEqual({ unreconciled_over_days: 30, disconnected_feed_hours: 36, stripe_ghl_mismatch_threshold: 0 });
    expect(c.tieout.tolerance).toBe("0.00");
    expect(c.ghl?.paid_subscriber_rule).toBeNull(); // D-3 pending
    expect(c.entities?.by_entity.PKG?.ghl_tags).toEqual([]);
  });

  it("accepts an empty config (a disabled lane) with every default", () => {
    const c = parseLaneConfig({});
    expect(c.enabled_modules).toEqual([]);
    expect(c.kpis).toEqual([]);
    expect(c.qbo).toBeUndefined();
  });

  it("rejects unknown keys at every level, including credential-named keys", () => {
    expect(issuesOf(() => parseLaneConfig({ ...VALID, client_secret: "x" }))[0]?.code).toBe("unrecognized_keys");
    expect(issuesOf(() => parseLaneConfig({ ...VALID, qbo: { ...VALID.qbo, refresh_token: "x" } }))[0]?.code).toBe("unrecognized_keys");
    expect(issuesOf(() => parseLaneConfig({ ...VALID, stripe: { ...VALID.stripe, api_key: "x" } }))[0]?.code).toBe("unrecognized_keys");
  });

  it("rejects bad shapes", () => {
    expect(() => parseLaneConfig({ kpis: ["not_a_kpi"] })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ qbo: { realm_id: "abc", entity_mapping_mode: "file" } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ stripe: { account_id: "acct_1", livemode: "yes" } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ finance: { weekly_cash_time: "25:00" } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ finance: { monthly_close_trigger: "day_of_month:31" } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ finance: { reports: { period: "forever" } } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ finance: { reports: { period: "year_to_date", class_id: "1" } } })).toThrow(z.ZodError);
    expect(parseLaneConfig({ finance: { reports: { period: "trailing_12_months" } } }).finance.reports.period).toBe("trailing_12_months");
    expect(() => parseLaneConfig({ finance: { reports: { kinds: ["general_ledger"] } } })).toThrow(z.ZodError);
    expect(parseLaneConfig({ finance: { reports: { kinds: ["pnl", "balance_sheet"] } } }).finance.reports.kinds).toEqual(["pnl", "balance_sheet"]);
    expect(parseLaneConfig({}).finance.reports.kinds).not.toContain("balance_sheet");
    // T-301: the weeks of the Finance weekly reports: 1 to 13 whole weeks, default 4.
    expect(parseLaneConfig({ finance: { reports: { weeks: 13 } } }).finance.reports.weeks).toBe(13);
    expect(parseLaneConfig({ finance: { reports: { weeks: 1 } } }).finance.reports.weeks).toBe(1);
    for (const bad of [0, 14, 2.5, "4", -1]) expect(() => parseLaneConfig({ finance: { reports: { weeks: bad } } })).toThrow(z.ZodError);
    // T-302: the cash history read of the nightly reports job: a boolean, OFF by default (fail closed).
    expect(parseLaneConfig({ finance: { reports: { cash_history: true } } }).finance.reports.cash_history).toBe(true);
    for (const bad of ["no", 0, null]) expect(() => parseLaneConfig({ finance: { reports: { cash_history: bad } } })).toThrow(z.ZodError);
    expect(parseLaneConfig({ finance: { qbo_sync: { interval_hours: 6 } } }).finance.qbo_sync.interval_hours).toBe(6);
    for (const bad of [0, 5, 24, 1.5, "4", -4]) expect(() => parseLaneConfig({ finance: { qbo_sync: { interval_hours: bad } } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ finance: { qbo_sync: { interval_hours: 4, extra: 1 } } })).toThrow(z.ZodError);
    expect(parseLaneConfig({}).finance.reports.kinds).not.toContain("cash_flow");
    expect(() => parseLaneConfig({ entities: { own_entity: "PKG", by_entity: { APK: {} } } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ entities: { own_entity: "PKG", by_entity: { pkg: {} } } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ approvals: { expire_after_hours: { "qbo.post": 1 } } })).toThrow(z.ZodError);
  });
  it("T-243: the one-time-code exclusion defaults include the generic sign-in link subjects (but not 'sign in to')", () => {
    const otp = parseLaneConfig({}).briefing.exclusions.otp_subjects;
    expect(otp).toEqual(expect.arrayContaining(["verification code", "login link", "log in link", "log-in link", "sign-in link", "sign in link", "magic link", "login url"]));
    expect(otp).not.toContain("sign in to");
    expect(parseLaneConfig({ briefing: { exclusions: { otp_subjects: ["otp"] } } }).briefing.exclusions.otp_subjects).toEqual(["otp"]);
  });

  it("rejects secret-looking values anywhere, naming the path but never the value", () => {
    const cases: [unknown, string][] = [
      [{ ghl: { location_id: "pit-0123456789abcdef" } }, "$.ghl.location_id"],
      [{ mailboxes: ["ops@example.test"], approvals: { monday_column_allowlist: ["sk_test_abc123"] } }, "$.approvals.monday_column_allowlist[0]"],
      [{ entities: { own_entity: "PKG", by_entity: { PKG: { ghl_tags: ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"] } } } }, "$.entities.by_entity.PKG.ghl_tags[0]"],
      [{ priority_senders: ["  sb_secret_abc  "] }, "$.priority_senders[0]"],
    ];
    for (const [input, path] of cases) {
      const issues = issuesOf(() => parseLaneConfig(input));
      expect(issues.map((i) => i.path[0])).toEqual([path]);
      expect(JSON.stringify(issues)).not.toMatch(/pit-0123|sk_test_abc|eyJhbGci|sb_secret_abc/);
    }
  });

  it("the synthetic PKG seed config is valid", async () => {
    // Plain-ESM seed module outside this package; a computed path keeps it out of the TS program.
    const seedModule = new URL("../../../../supabase/core/seed/sections/lane-config.mjs", import.meta.url).href;
    const { PKG_CONFIG } = (await import(/* @vite-ignore */ seedModule)) as { PKG_CONFIG: unknown };
    expect(parseLaneConfig(PKG_CONFIG).entities?.own_entity).toBe("PKG");
  });

  it("accepts free-text GoHighLevel tags with spaces and mixed case", () => {
    const c = parseLaneConfig({ ghl: { location_id: "loc-1", paid_subscriber_rule: { tags: ["Paid Member", "VIP 2026"] } } });
    expect(c.ghl?.paid_subscriber_rule?.tags).toEqual(["Paid Member", "VIP 2026"]);
    expect(() => parseLaneConfig({ ghl: { location_id: "loc-1", paid_subscriber_rule: { tags: ["bad\ntag"] } } })).toThrow(z.ZodError);
  });

  it("allows only the owner as approver and caps the step-up age", () => {
    expect(() => parseLaneConfig({ approvals: { approver_roles: ["viewer"] } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ approvals: { approver_roles: ["owner", "finance_operator"] } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ approvals: { approver_roles: [] } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ approvals: { step_up_max_age_s: 3600 } })).toThrow(z.ZodError);
    // T-286 (D-67): the Teams window is its own key, 300 to 43,200 seconds; email's key stays capped at 900
    expect(parseLaneConfig({ approvals: { teams_step_up_max_age_s: 28800 } }).approvals.teams_step_up_max_age_s).toBe(28800);
    expect(() => parseLaneConfig({ approvals: { teams_step_up_max_age_s: 299 } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ approvals: { teams_step_up_max_age_s: 43201 } })).toThrow(z.ZodError);
    expect(parseLaneConfig({ approvals: { teams_step_up_max_age_s: 3600 } }).approvals.step_up_max_age_s).toBe(300);
    // (the Teams types are not in ACTION_TYPES: that list maps one to one to the employee permission table of the brain module; the database's 1-hour Teams expiry needs no setting)
    expect(ACTION_TYPES).not.toContain("teams.chat.send");
    // T-192: the reconcile give-up time is at least the reconcile threshold + 5 minutes.
    expect(parseLaneConfig({ approvals: {} }).approvals).toMatchObject({ reconcile_after_minutes: 10, reconcile_give_up_minutes: 60 });
    expect(parseLaneConfig({ approvals: { reconcile_after_minutes: 20, reconcile_give_up_minutes: 25 } }).approvals.reconcile_give_up_minutes).toBe(25);
    expect(() => parseLaneConfig({ approvals: { reconcile_after_minutes: 20, reconcile_give_up_minutes: 24 } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ approvals: { reconcile_after_minutes: 4 } })).toThrow(z.ZodError);
    expect(parseLaneConfig({}).assistant.max_snippet_chars).toBe(300);
  });

  it("news (T-234 part 4): off by default, generic topics and official domains, bounded values, strict", () => {
    const n = parseLaneConfig({}).news;
    expect(n).toMatchObject({ enabled: false, time: "06:00", max_searches: 6, max_tokens: 8000, monthly_cap_usd: 20, cost_per_1000_searches_usd: 10, blocked_domains: [] });
    expect(n.topics).toHaveLength(6);
    expect(n.preferred_domains).toEqual(["acquisition.gov", "federalregister.gov", "gsa.gov", "sam.gov", "defense.gov"]);
    expect(parseLaneConfig({ news: { enabled: true, monthly_cap_usd: 5 } }).news).toMatchObject({ enabled: true, monthly_cap_usd: 5 });
    for (const bad of [{ monthly_cap_usd: 0 }, { monthly_cap_usd: 5000 }, { time: "6:00" }, { max_searches: 11 }, { max_tokens: 1999 }, { max_tokens: 32001 }, { max_tokens: 8000.5 }, { topics: [] }, { topics: ["<script>"] }, { blocked_domains: ["https://x.test/p"] }, { preferred_domains: ["x y.test"] }, { allowed_domains: ["x.test"] }, { cost_per_1000_searches_usd: -1 }]) {
      expect(() => parseLaneConfig({ news: bad })).toThrow(z.ZodError);
    }
  });

  it("refuses input nested deeper than the limit without recursing further", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 10_000; i++) deep = [deep];
    expect(findSecretLikeValues(deep)).toHaveLength(1);
    expect(() => parseLaneConfig({ kpis: deep })).toThrow(z.ZodError);
  });

  it("pilot.connection_test_enabled (T-198) is optional, boolean and strict", () => {
    expect(parseLaneConfig({}).pilot).toBeUndefined();
    expect(parseLaneConfig({ pilot: {} }).pilot?.connection_test_enabled).toBe(false);
    expect(parseLaneConfig({ pilot: { connection_test_enabled: true } }).pilot?.connection_test_enabled).toBe(true);
    expect(() => parseLaneConfig({ pilot: { connection_test_enabled: "yes" } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ pilot: { connection_test_enabled: true, other: 1 } })).toThrow(z.ZodError);
  });

  it("findSecretLikeValues ignores ordinary values", () => {
    expect(findSecretLikeValues(laneConfigSchema.parse(VALID))).toEqual([]);
  });
});

describe("retention settings (T-042)", () => {
  it("accepts values inside the database floors and caps, refuses others and unknown keys", () => {
    expect(laneConfigSchema.parse({ retention: { calendar_days: 30, webhook_days: 7, conversations_days: 90 } }).retention.calendar_days).toBe(30);
    for (const retention of [{ calendar_days: 29 }, { calendar_days: 181 }, { webhook_days: 6 }, { conversations_days: 0 }, { comms_days: 90 }]) {
      expect(laneConfigSchema.safeParse({ retention }).success, JSON.stringify(retention)).toBe(false);
    }
  });
});

describe("finance.payroll (D-25, T-051)", () => {
  it("defaults to Intuit's payroll subtypes, no ids and no excluded entities", () => {
    const c = laneConfigSchema.parse({});
    expect(c.finance.payroll.account_ids).toEqual([]);
    expect(c.finance.payroll.excluded_entity_ids).toEqual([]);
    expect(c.finance.payroll.account_subtypes).toEqual([...QBO_PAYROLL_SUBTYPES]);
    expect(c.finance.payroll.account_subtypes).toContain("PayrollExpenses");
  });
  it("accepts explicit lists and rejects malformed ones and unknown keys", () => {
    const ok = laneConfigSchema.parse({ finance: { payroll: { account_ids: ["12"], account_subtypes: ["PayrollClearing"], excluded_entity_ids: ["99"] } } });
    expect(ok.finance.payroll).toEqual({ account_ids: ["12"], account_subtypes: ["PayrollClearing"], excluded_entity_ids: ["99"] });
    for (const payroll of [{ account_ids: ["x"] }, { account_subtypes: ["has space"] }, { excluded_entity_ids: [12] }, { other: 1 }]) {
      expect(laneConfigSchema.safeParse({ finance: { payroll } }).success, JSON.stringify(payroll)).toBe(false);
    }
  });
});

describe("action types and shared validators (T-211, D-34)", () => {
  it("includes email.save_draft with a 72 h expiry default, and keeps email.draft as an alias", () => {
    expect(ACTION_TYPES).toContain("email.save_draft");
    expect(ACTION_TYPES).toContain("email.draft");
    expect(parseLaneConfig({}).approvals.expire_after_hours["email.save_draft"]).toBe(72);
    expect(parseLaneConfig({ approvals: { expire_after_hours: { "email.save_draft": 24 } } }).approvals.expire_after_hours).toEqual({ "email.save_draft": 24 });
  });
  it("copies a legacy email.draft expiry to email.save_draft and refuses two different values (T-211 review)", () => {
    expect(parseLaneConfig({ approvals: { expire_after_hours: { "email.draft": 48 } } }).approvals.expire_after_hours["email.save_draft"]).toBe(48);
    expect(() => parseLaneConfig({ approvals: { expire_after_hours: { "email.draft": 48, "email.save_draft": 24 } } })).toThrow(z.ZodError);
    expect(parseLaneConfig({ approvals: { expire_after_hours: { "email.draft": 24, "email.save_draft": 24 } } }).approvals.expire_after_hours["email.save_draft"]).toBe(24);
  });
  it("exports laneCode, email and hhmm for the employee config", () => {
    expect(laneCode.safeParse("AB").success).toBe(true);
    expect(laneCode.safeParse("ab").success).toBe(false);
    expect(email.safeParse("a@example.com").success).toBe(true);
    expect(hhmm.safeParse("06:30").success).toBe(true);
    expect(hhmm.safeParse("24:00").success).toBe(false);
  });
});

describe("briefing schedule (D-32, T-231c)", () => {
  it("defaults to 06:30 Mon-Fri with the schedule off", () => {
    const b = laneConfigSchema.shape.briefing.parse({});
    expect(b.time).toBe("06:30");
    expect(b.days).toEqual([1, 2, 3, 4, 5]);
    expect(b.schedule_enabled).toBe(false);
  });
  it("accepts custom days and rejects out-of-range, duplicate or empty lists", () => {
    expect(laneConfigSchema.shape.briefing.parse({ days: [0, 6] }).days).toEqual([0, 6]);
    for (const days of [[7], [-1], [1, 1], [], [1.5]]) expect(laneConfigSchema.shape.briefing.safeParse({ days }).success).toBe(false);
  });
});

describe("briefing exclusions: subject prefixes (T-234 part 2 review)", () => {
  const parse = (exclusions: unknown) => laneConfigSchema.shape.briefing.safeParse({ exclusions });
  it("the defaults are valid prefixes (at least 4 characters, ending with a colon)", () => {
    const x = laneConfigSchema.shape.briefing.parse({}).exclusions;
    for (const p of [...x.calendar_subjects, ...x.auto_reply_subjects]) {
      expect(p.length).toBeGreaterThanOrEqual(4);
      expect(p.endsWith(":")).toBe(true);
    }
  });
  it.each(["calendar_subjects", "auto_reply_subjects"])("%s rejects a short entry and an entry without a trailing colon", (key) => {
    expect(parse({ [key]: ["Re:"] }).success).toBe(false); // 3 characters
    expect(parse({ [key]: ["Accepted"] }).success).toBe(false); // no colon
    expect(parse({ [key]: ["Hi"] }).success).toBe(false);
    expect(parse({ [key]: ["Canceled:"] }).success).toBe(true);
  });
});

describe("T-236: briefing.max_tokens", () => {
  it("defaults to 8000 and accepts 2000..32000 integers only", () => {
    expect(laneConfigSchema.parse({}).briefing.max_tokens).toBe(8000);
    expect(laneConfigSchema.parse({ briefing: { max_tokens: 12000 } }).briefing.max_tokens).toBe(12000);
    for (const bad of [1999, 32001, 8000.5, "8000"]) expect(laneConfigSchema.safeParse({ briefing: { max_tokens: bad } }).success).toBe(false);
  });
});


describe("T-240: briefing.attention.fresh_hours, deadline_subjects, own_domain_bulk_senders", () => {
  const parse = (briefing: unknown) => laneConfigSchema.shape.briefing.safeParse(briefing);
  it("defaults: 48 hours, generic deadline words, non-person local parts", () => {
    const b = laneConfigSchema.shape.briefing.parse({});
    expect(b.attention.fresh_hours).toBe(48);
    expect(b.deadline_subjects).toEqual(["deadline", "due today", "due tomorrow", "by EOD", "RFP", "proposal due", "expires"]);
    expect(b.exclusions.own_domain_bulk_senders).toContain("no-reply@");
    expect(b.exclusions.own_domain_bulk_senders).toContain("newsletter@");
  });
  it("fresh_hours is a whole number from 6 to 168; unknown keys are refused", () => {
    expect(parse({ attention: { fresh_hours: 6 } }).success).toBe(true);
    expect(parse({ attention: { fresh_hours: 168 } }).success).toBe(true);
    for (const fresh_hours of [5, 169, 0, -1, 48.5, "48"]) expect(parse({ attention: { fresh_hours } }).success).toBe(false);
    expect(parse({ attention: { fresh_hours: 24, extra: 1 } }).success).toBe(false);
    expect(laneConfigSchema.parse({ briefing: { attention: { fresh_hours: 72 } } }).briefing.attention.fresh_hours).toBe(72);
  });
  it("deadline_subjects is a list of plain text patterns", () => {
    expect(parse({ deadline_subjects: ["cutoff"] }).success).toBe(true);
    expect(parse({ deadline_subjects: [""] }).success).toBe(false);
  });
});

describe("mail section (T-247)", () => {
  it("defaults to empty lists (fail closed): no domain is allowed until a lane lists it", () => {
    const c = parseLaneConfig(VALID);
    expect(c.mail).toEqual({ providers: ["google"], allowed_domains: [], self_connect_domains: [] });
  });
  it("accepts lower-case domains for both keys", () => {
    const c = parseLaneConfig({ ...VALID, mail: { allowed_domains: ["example.test", "mail.example.test"], self_connect_domains: ["gmail.example.test"] } });
    expect(c.mail.allowed_domains).toEqual(["example.test", "mail.example.test"]);
    expect(c.mail.self_connect_domains).toEqual(["gmail.example.test"]);
  });
  it.each([["Example.Test"], ["example"], ["@example.test"], ["https://example.test"], ["*.example.test"], ["example.test/path"], ["ex ample.test"], [" example.test"], ["example..test"], ["-a.example.test"]])(
    "rejects %j as a domain",
    (d) => {
      expect(() => parseLaneConfig({ ...VALID, mail: { allowed_domains: [d] } })).toThrow();
      expect(() => parseLaneConfig({ ...VALID, mail: { self_connect_domains: [d] } })).toThrow();
    },
  );
  it("rejects unknown keys and more than 20 entries", () => {
    expect(() => parseLaneConfig({ ...VALID, mail: { allowed: ["example.test"] } })).toThrow();
    expect(() => parseLaneConfig({ ...VALID, mail: { allowed_domains: Array.from({ length: 21 }, (_, i) => `d${String(i)}.example.test`) } })).toThrow();
  });
  it("keeps the exact mailbox list next to it", () => {
    const c = parseLaneConfig({ ...VALID, mail: { allowed_domains: ["example.test"] } });
    expect(c.mailboxes).toEqual(["ops@example.test"]);
    expect(c.mail.allowed_domains).toEqual(["example.test"]);
  });
});

describe("mail provider and Microsoft settings (T-250)", () => {
  // Synthetic tenant ids only (rule 10).
  const T1 = "11111111-2222-4333-8444-555555555555";
  const T2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const MS = { tenant_ids: [T1] };
  const msConfig = (extra: Record<string, unknown> = {}) => ({ ...VALID, mail: { provider: "microsoft" }, microsoft: MS, ...extra });

  it("defaults to google with no microsoft block; a stored PKG-style config (no provider keys) still parses unchanged", () => {
    const stored = { ...VALID, mail: { allowed_domains: ["example.test"], self_connect_domains: [] }, mail_transport: "composio", calendar: { calendar_ids: ["primary"] } };
    const c = parseLaneConfig(stored);
    expect(c.mail.providers).toEqual(["google"]);
    expect(c.microsoft).toBeUndefined();
    expect(parseLaneConfig(VALID).mail.providers).toEqual(["google"]);
    expect(parseLaneConfig({}).mail.providers).toEqual(["google"]);
  });
  it("parses a config shaped like the stored production PKG one (modules, mailboxes, mail_transport native; no provider keys)", () => {
    const c = parseLaneConfig({ enabled_modules: ["assistant", "comms"], mailboxes: ["owner@example.test"], mail_transport: "native" });
    expect(c.mail.providers).toEqual(["google"]);
    expect(c.microsoft).toBeUndefined();
  });
  it("refuses the personal-accounts tenant and the nil UUID in tenant_ids", () => {
    for (const id of ["9188040d-6c67-4c5b-b112-36a304b66dad", "00000000-0000-0000-0000-000000000000"]) {
      expect(() => parseLaneConfig(msConfig({ microsoft: { tenant_ids: [id] } }))).toThrow();
      expect(() => parseLaneConfig(msConfig({ microsoft: { tenant_ids: [T1, id] } }))).toThrow();
    }
  });
  it("accepts microsoft with defaults: commercial, allow_gcc false, inbox and sentitems", () => {
    const c = parseLaneConfig(msConfig());
    expect(c.mail.providers).toEqual(["microsoft"]);
    expect(c.microsoft).toEqual({ cloud: "commercial", tenant_ids: [T1], allow_gcc: false, mail_folders: ["inbox", "sentitems"] });
  });
  it("accepts every field set explicitly", () => {
    const c = parseLaneConfig(msConfig({ microsoft: { cloud: "gcc_high", tenant_ids: [T1, T2], allow_gcc: true, mail_folders: ["archive", "inbox", "sentitems"] } }));
    expect(c.microsoft).toEqual({ cloud: "gcc_high", tenant_ids: [T1, T2], allow_gcc: true, mail_folders: ["archive", "inbox", "sentitems"] });
  });
  it("rejects an unknown provider", () => {
    for (const bad of ["Microsoft", "outlook", "", null]) expect(() => parseLaneConfig({ ...VALID, mail: { provider: bad } }), String(bad)).toThrow();
  });
  it("requires the microsoft block when the legacy mail.provider is microsoft", () => {
    const issues = issuesOf(() => parseLaneConfig({ ...VALID, mail: { provider: "microsoft" } }));
    expect(issues.some((i) => i.path.join(".") === "microsoft")).toBe(true);
  });
  it("allows a microsoft block while microsoft is not in mail.providers (a lane prepared before use, or paused)", () => {
    const c = parseLaneConfig({ ...VALID, microsoft: MS });
    expect(c.mail.providers).toEqual(["google"]);
    expect(c.microsoft?.tenant_ids).toEqual([T1]);
  });
  it("refuses mail_transport composio with microsoft, but not with google", () => {
    const issues = issuesOf(() => parseLaneConfig(msConfig({ mail_transport: "composio" })));
    expect(issues.some((i) => i.path.join(".") === "mail_transport")).toBe(true);
    expect(parseLaneConfig(msConfig({ mail_transport: "native" })).mail_transport).toBe("native");
    expect(parseLaneConfig({ ...VALID, mail_transport: "composio", microsoft: MS }).mail_transport).toBe("composio");
  });
  it("tenant_ids: 1..10 lower-case UUIDs, no duplicates, no upper-case (refused, not lower-cased)", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(parseLaneConfig(msConfig({ microsoft: { tenant_ids: ten } })).microsoft?.tenant_ids).toEqual(ten);
    const eleven = [...ten, "00000000-0000-4000-8000-0000000000ff"];
    for (const bad of [[], eleven, [T1, T1], [T2.toUpperCase()], ["not-a-uuid"], [`{${T1}}`], [` ${T1}`], [T1.replaceAll("-", "")], [5], "x"]) {
      expect(() => parseLaneConfig(msConfig({ microsoft: { tenant_ids: bad } })), JSON.stringify(bad)).toThrow();
    }
    expect(() => parseLaneConfig(msConfig({ microsoft: {} }))).toThrow();
  });
  it("cloud: commercial or gcc_high only", () => {
    expect(parseLaneConfig(msConfig({ microsoft: { ...MS, cloud: "gcc_high" } })).microsoft?.cloud).toBe("gcc_high");
    for (const bad of ["gcc", "dod", "Commercial", ""]) expect(() => parseLaneConfig(msConfig({ microsoft: { ...MS, cloud: bad } })), bad).toThrow();
  });
  it("allow_gcc is a boolean", () => {
    expect(parseLaneConfig(msConfig({ microsoft: { ...MS, allow_gcc: true } })).microsoft?.allow_gcc).toBe(true);
    for (const bad of ["true", 1, null]) expect(() => parseLaneConfig(msConfig({ microsoft: { ...MS, allow_gcc: bad } }))).toThrow();
  });
  it("mail_folders: subset of inbox, sentitems, archive; 1..3; no duplicates", () => {
    expect(parseLaneConfig(msConfig({ microsoft: { ...MS, mail_folders: ["inbox"] } })).microsoft?.mail_folders).toEqual(["inbox"]);
    for (const bad of [[], ["inbox", "inbox"], ["drafts"], ["junkemail"], ["Inbox"], ["inbox", "sentitems", "archive", "inbox"], "inbox"]) {
      expect(() => parseLaneConfig(msConfig({ microsoft: { ...MS, mail_folders: bad } })), JSON.stringify(bad)).toThrow();
    }
  });
  it("the microsoft block is strict: unknown keys are rejected", () => {
    for (const extra of [{ tenant: T1 }, { client_id: "x" }, { mailboxes: [] }]) expect(() => parseLaneConfig(msConfig({ microsoft: { ...MS, ...extra } }))).toThrow();
  });
  it("calendar.calendar_ids character rule also accepts a Graph-style id (the list itself is Google-only, T-269)", () => {
    const id = "AAMkAGI2synthetic-calendar-id=";
    expect(parseLaneConfig(msConfig({ calendar: { calendar_ids: [id] } })).calendar?.calendar_ids).toEqual([id]);
  });
  it("the secret-value scan covers the new keys: a credential-like value is refused, ordinary values are not", () => {
    expect(findSecretLikeValues(msConfig())).toEqual([]);
    expect(findSecretLikeValues({ microsoft: { tenant_ids: ["ya29.synthetic"], mail_folders: ["Bearer abc"] }, mail: { provider: "sk-ant-synthetic" } }).sort()).toEqual([
      "$.mail.provider",
      "$.microsoft.mail_folders[0]",
      "$.microsoft.tenant_ids[0]",
    ]);
    expect(() => parseLaneConfig(msConfig({ microsoft: { tenant_ids: ["ya29.synthetic"] } }))).toThrow(/secret-like/);
  });
});

describe("several mail providers per lane (T-269, D-57)", () => {
  const T1 = "11111111-2222-4333-8444-555555555555"; // synthetic
  const MS = { tenant_ids: [T1] };
  const withMail = (mail: unknown, extra: Record<string, unknown> = {}) => ({ ...VALID, mail, ...extra });
  const paths = (fn: () => unknown) => issuesOf(fn).map((i) => i.path.join("."));

  it("a stored config with no provider keys reads [google]", () => {
    expect(parseLaneConfig(VALID).mail.providers).toEqual(["google"]);
    expect(parseLaneConfig(withMail({})).mail.providers).toEqual(["google"]);
  });
  it("the legacy mail.provider is read as a one-element list and is never emitted", () => {
    const ms = parseLaneConfig(withMail({ provider: "microsoft" }, { microsoft: MS }));
    expect(ms.mail.providers).toEqual(["microsoft"]);
    expect("provider" in ms.mail).toBe(false);
    const g = parseLaneConfig(withMail({ provider: "google", allowed_domains: ["example.test"] }));
    expect(g.mail).toEqual({ providers: ["google"], allowed_domains: ["example.test"], self_connect_domains: [] });
    // Re-parsing what the app would write (the parsed config) is stable and carries providers only.
    const again = parseLaneConfig(JSON.parse(JSON.stringify(ms)));
    expect(again).toEqual(ms);
    expect(JSON.stringify(again.mail)).not.toContain('"provider"');
  });
  it("accepts both providers with the microsoft block; each order and a single entry parse", () => {
    expect(parseLaneConfig(withMail({ providers: ["google", "microsoft"] }, { microsoft: MS })).mail.providers).toEqual(["google", "microsoft"]);
    expect(parseLaneConfig(withMail({ providers: ["microsoft", "google"] }, { microsoft: MS })).mail.providers).toEqual(["microsoft", "google"]);
    expect(parseLaneConfig(withMail({ providers: ["microsoft"] }, { microsoft: MS })).mail.providers).toEqual(["microsoft"]);
  });
  it("refuses microsoft in providers without the microsoft block", () => {
    expect(paths(() => parseLaneConfig(withMail({ providers: ["microsoft"] })))).toContain("microsoft");
    expect(paths(() => parseLaneConfig(withMail({ providers: ["google", "microsoft"] })))).toContain("microsoft");
  });
  it("allows the microsoft block without microsoft in providers", () => {
    expect(parseLaneConfig(withMail({ providers: ["google"] }, { microsoft: MS })).microsoft?.tenant_ids).toEqual([T1]);
  });
  it("mail_transport composio: accepted with google (also with both), refused with microsoft only", () => {
    expect(parseLaneConfig(withMail({ providers: ["google", "microsoft"] }, { microsoft: MS, mail_transport: "composio" })).mail_transport).toBe("composio");
    expect(parseLaneConfig(withMail({ providers: ["google"] }, { mail_transport: "composio" })).mail_transport).toBe("composio");
    expect(paths(() => parseLaneConfig(withMail({ providers: ["microsoft"] }, { microsoft: MS, mail_transport: "composio" })))).toContain("mail_transport");
  });
  it("refuses an empty list, duplicates, an unknown provider, a non-array and more than two entries", () => {
    for (const bad of [[], ["google", "google"], ["microsoft", "microsoft"], ["outlook"], ["Google"], [null], "google", null, { 0: "google" }, ["google", "microsoft", "google"]]) {
      expect(() => parseLaneConfig(withMail({ providers: bad }, { microsoft: MS })), JSON.stringify(bad)).toThrow();
    }
  });
  it("refuses both keys present, whatever their values", () => {
    for (const mail of [{ provider: "google", providers: ["google"] }, { provider: "microsoft", providers: ["google", "microsoft"] }, { provider: "google", providers: ["microsoft"] }, { provider: "microsoft", providers: ["google"] }]) {
      expect(paths(() => parseLaneConfig(withMail(mail, { microsoft: MS })))).toContain("mail.providers");
    }
  });
  it("microsoft.calendar_ids: optional, 1..5, unique, same character rule as the Google ids", () => {
    const ids = (a: unknown) => parseLaneConfig({ ...VALID, microsoft: { ...MS, calendar_ids: a } });
    expect(parseLaneConfig({ ...VALID, microsoft: MS }).microsoft?.calendar_ids).toBeUndefined();
    expect(ids(["AAMkAGI2synthetic-id="]).microsoft?.calendar_ids).toEqual(["AAMkAGI2synthetic-id="]);
    expect(ids(["a", "b", "c", "d", "e"]).microsoft?.calendar_ids).toHaveLength(5);
    for (const bad of [[], ["a", "b", "c", "d", "e", "f"], ["a", "a"], [""], ["has space"], ["tab\t"], ["x".repeat(201)], "a", [1]]) {
      expect(() => ids(bad), JSON.stringify(bad)).toThrow();
    }
    expect(ids(["x".repeat(200)]).microsoft?.calendar_ids).toHaveLength(1);
  });
  it("calendar.calendar_ids keeps its Google meaning and limits (1..10)", () => {
    expect(parseLaneConfig({ ...VALID, calendar: { calendar_ids: ["a", "b", "c", "d", "e", "f"] } }).calendar?.calendar_ids).toHaveLength(6);
    expect(() => parseLaneConfig({ ...VALID, calendar: { calendar_ids: [] } })).toThrow();
  });
  it("the secret scan covers microsoft.calendar_ids and mail.providers", () => {
    expect(findSecretLikeValues({ microsoft: { calendar_ids: ["ordinary-id", "ya29.synthetic"] }, mail: { providers: ["sk-ant-synthetic"] } }).sort()).toEqual([
      "$.mail.providers[0]",
      "$.microsoft.calendar_ids[1]",
    ]);
    expect(() => parseLaneConfig({ ...VALID, microsoft: { ...MS, calendar_ids: ["ya29.synthetic"] } })).toThrow(/secret-like/);
  });
});
