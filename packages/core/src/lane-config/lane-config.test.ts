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
    expect(c.finance).toEqual({ accounting_method: "accrual", weekly_cash_time: "06:00", monthly_close_trigger: "manual", payroll: { account_ids: [], account_subtypes: [...QBO_PAYROLL_SUBTYPES], excluded_entity_ids: [] }, reports: { period: "year_to_date", kinds: ["pnl", "ar_aging_summary", "ap_aging_summary"] }, qbo_sync: { interval_hours: 4 } });
    expect(c.approvals.approvals_live).toBe(false);
    expect(c.approvals.step_up_max_age_s).toBe(300);
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
    expect(parseLaneConfig({ finance: { qbo_sync: { interval_hours: 6 } } }).finance.qbo_sync.interval_hours).toBe(6);
    for (const bad of [0, 5, 24, 1.5, "4", -4]) expect(() => parseLaneConfig({ finance: { qbo_sync: { interval_hours: bad } } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ finance: { qbo_sync: { interval_hours: 4, extra: 1 } } })).toThrow(z.ZodError);
    expect(parseLaneConfig({}).finance.reports.kinds).not.toContain("cash_flow");
    expect(() => parseLaneConfig({ entities: { own_entity: "PKG", by_entity: { APK: {} } } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ entities: { own_entity: "PKG", by_entity: { pkg: {} } } })).toThrow(z.ZodError);
    expect(() => parseLaneConfig({ approvals: { expire_after_hours: { "qbo.post": 1 } } })).toThrow(z.ZodError);
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
    expect(parseLaneConfig({}).assistant.max_snippet_chars).toBe(300);
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
