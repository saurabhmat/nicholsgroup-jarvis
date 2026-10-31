import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findSecretLikeValues, laneConfigSchema, parseLaneConfig } from "./index";

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

describe("lane config schema", () => {
  it("accepts a valid config and fills the spec defaults", () => {
    const c = parseLaneConfig(VALID);
    expect(c.finance).toEqual({ accounting_method: "accrual", weekly_cash_time: "06:00", monthly_close_trigger: "manual" });
    expect(c.approvals.approvals_live).toBe(false);
    expect(c.approvals.step_up_max_age_s).toBe(300);
    expect(c.approvals.expire_after_hours).toEqual({ "email.draft": 72, "email.send": 72, "monday.item": 168 });
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

  it("findSecretLikeValues ignores ordinary values", () => {
    expect(findSecretLikeValues(laneConfigSchema.parse(VALID))).toEqual([]);
  });
});
