// Lane registry and lane policies (T-010). The lane code is the key; later sections reference lanes by code.
// Policies follow architecture §5.3: PKG is the pilot lane (D-19: outbound drafts stored), NL is limited to finance
// summaries, and every other lane keeps the restrictive column defaults.
import { lit, values } from "../sql.mjs";

/** @param {readonly string[]} items */
const textArray = (items) => (items.length === 0 ? "array[]::text[]" : `array[${values(...items)}]::text[]`);

/** Non-default policy values per lane code; lanes not listed get the column defaults (everything off, 30 days). */
const POLICIES = {
  PKG: {
    llm: ["email", "calendar", "docs", "finance", "tasks", "brain_import", "web"],
    storeOutboundDrafts: true,
    retentionDays: 90,
    crossLane: "summary",
    writes: ["email_draft", "email_send", "calendar", "monday", "notion"],
  },
  NL: { llm: ["finance_summary"], storeOutboundDrafts: false, retentionDays: 30, crossLane: "status", writes: [] },
};

/** @type {import("./index.mjs").SeedSection} */
export default {
  id: "lanes",
  description: "lane registry (only PKG enabled) and lane policies",
  build(ctx) {
    const { epoch, lanes } = ctx.data;
    const out = [];
    for (const l of lanes) {
      out.push(
        "insert into core.lanes (code, name, data_plane, enabled, created_at, updated_at) values (" +
          `${values(l.code, l.name, l.dataPlane, l.enabled, epoch, epoch)}) on conflict (code) do nothing;`,
      );
    }
    for (const l of lanes) {
      const p = POLICIES[l.code];
      if (!p) {
        out.push(
          "insert into core.lane_policies (lane_id, created_at, updated_at) values (" +
            `${values(l.code, epoch, epoch)}) on conflict (lane_id) do nothing;`,
        );
        continue;
      }
      out.push(
        "insert into core.lane_policies (lane_id, llm_allowed_categories, store_content_bodies, store_outbound_drafts, " +
          "indexing_enabled, retention_days, cross_lane_summary_allowed, write_actions_allowed, created_at, updated_at) values (" +
          `${lit(l.code)}, ${textArray(p.llm)}, ${values(false, p.storeOutboundDrafts, false, p.retentionDays, p.crossLane)}, ` +
          `${textArray(p.writes)}, ${values(epoch, epoch)}) on conflict (lane_id) do nothing;`,
      );
    }
    return out;
  },
};
