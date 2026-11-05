// Lane config version 1 per lane (T-011). PKG gets a full synthetic config (fake realm, account, location and ids);
// every other lane gets {} (all defaults, nothing connected). Validated against the shared Zod schema by
// packages/core/src/lane-config/lane-config.test.ts.
import { json, lit, values } from "../sql.mjs";

/** Synthetic PKG config. Ids are obviously fake; the real ones are set in production by a human. */
export const PKG_CONFIG = Object.freeze({
  enabled_modules: ["finance", "approvals", "assistant", "briefing", "comms", "calendar", "projects"],
  kpis: [
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
  ],
  qbo: { realm_id: "1001", entity_mapping_mode: "file_class" },
  stripe: { account_id: "acct_synthetic0001", livemode: false },
  ghl: { location_id: "loc-synthetic-0001", paid_subscriber_rule: null },
  entities: {
    own_entity: "PKG",
    by_entity: {
      PKG: { qbo_class_ids: ["class-synthetic-pkg"], qbo_customer_ids: [], stripe_product_ids: ["prod_synthetic_pkg"], ghl_tags: ["tag-synthetic-pkg"], ghl_products: [] },
      APK: { qbo_class_ids: ["class-synthetic-apk"], qbo_customer_ids: [], stripe_product_ids: ["prod_synthetic_apk"], ghl_tags: ["tag-synthetic-apk"], ghl_products: [] },
      PKI: { qbo_class_ids: ["class-synthetic-pki"], qbo_customer_ids: [], stripe_product_ids: ["prod_synthetic_pki"], ghl_tags: ["tag-synthetic-pki"], ghl_products: [] },
    },
    bank_accounts: [
      { qbo_account_id: "bank-synthetic-1", owner_entity: "PKG" },
      { qbo_account_id: "bank-synthetic-2", owner_entity: "APK" },
    ],
  },
  mailboxes: ["ops@example.test"],
  priority_senders: ["owner@example.test"],
  metrics: { start_month: "2025-01" },
  approvals: { approvals_live: false, approver_roles: ["owner"], allowed_mailboxes: ["ops@example.test"] },
});

/** @type {import("./index.mjs").SeedSection} */
export default {
  id: "lane-config",
  description: "lane config version 1: synthetic PKG settings, defaults for the other lanes",
  build(ctx) {
    const { epoch, lanes } = ctx.data;
    return lanes.map(
      (l) =>
        // `where not exists`, not `on conflict`: the insert-only trigger refuses a duplicate version before any
        // conflict handling, so this keeps the seed re-runnable.
        "insert into core.lane_config (lane_id, version, config, created_at) select " +
        `${values(l.code, 1)}, ${json(l.code === "PKG" ? PKG_CONFIG : {})}, ${values(epoch)} ` +
        `where not exists (select 1 from core.lane_config where lane_id = ${lit(l.code)});`,
    );
  },
};
