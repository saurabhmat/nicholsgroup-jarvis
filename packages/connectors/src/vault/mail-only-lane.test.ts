// T-265 audit: every lane-config reader a scheduled job or a fan-out uses, run against the config of a lane with mail and calendar ONLY
// (no qbo, stripe, ghl, kpis, finance, entities, news, approvals). Synthetic tenant and domain. Each reader must answer (a default, null or
// a list), never throw: a throw here is a failed job and, three in a row, an alert for a lane that did nothing wrong.
import { describe, expect, it } from "vitest";
import { createLaneConfigReader } from "./lane-config";

const TENANT = "11111111-2222-4333-8444-555555555555";
const MAIL_ONLY = {
  enabled_modules: ["comms", "calendar", "briefing"],
  limit_to_enabled_modules: true,
  mail: { providers: ["microsoft"], allowed_domains: ["mail-only.example.test"] },
  microsoft: { cloud: "commercial", tenant_ids: [TENANT] },
};
const reader = (config: unknown, policy: unknown = { retention_days: 90 }) =>
  createLaneConfigReader((async () => ({
    schema: () => ({
      from: (table: string) => {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: table === "lane_policies" ? policy : config === undefined ? null : { config }, error: null }) };
        return q;
      },
    }),
  })) as never);

describe("readers over a mail-only lane config (T-265)", () => {
  it("every reader answers; the finance ones fall back to their defaults or null", async () => {
    const r = reader(MAIL_ONLY);
    expect(await r.mailProviders("XX")).toEqual(["microsoft"]);
    expect(await r.isMailProviderEnabled("XX", "microsoft")).toBe(true);
    expect(await r.isMailProviderEnabled("XX", "google")).toBe(false);
    expect(await r.mailDomains("XX")).toEqual(["mail-only.example.test"]);
    expect((await r.microsoftSettings("XX"))?.tenantIds).toEqual([TENANT]);
    expect(await r.mailboxes("XX")).toEqual([]);
    expect(await r.calendarSettings("XX")).toMatchObject({ calendarIds: null, includeReadOnly: false });
    expect(await r.retentionConfig("XX")).toEqual({ calendarDays: 180, conversationsDays: 180, webhookDays: 30 });
    expect(await r.retentionSettings("XX")).toMatchObject({ commsDays: 90 });
    expect(await r.qboSyncIntervalHours("XX")).toBe(4); // fin.sync asks every enabled lane; the lane then lists no QuickBooks connection
    expect(await r.qboRealmId("XX")).toBeNull(); // the QuickBooks webhook resolves a realm per served lane
    expect(await r.payrollSettings("XX")).toMatchObject({ accountIds: [] });
    expect(await r.reportSettings("XX")).toMatchObject({ classIds: [] });
  });

  it("a lane that has no config row yet also answers with defaults (the window between enabling the lane and writing its config)", async () => {
    const r = reader(undefined);
    expect(await r.qboSyncIntervalHours("XX")).toBe(4);
    expect(await r.qboRealmId("XX")).toBeNull();
    expect(await r.mailProviders("XX")).toEqual(["google"]); // the default: nothing about Microsoft is enabled until the version exists
    expect(await r.retentionConfig("XX")).toMatchObject({ webhookDays: 30 });
  });
});

// T-265: the real planners over a lane that answers the mail-only config (and, for the QuickBooks lists, has no QuickBooks connection).
describe("fan-out planners over a mail-only lane (T-265)", () => {
  it("fin.sync and fin.qbo_reports plan no work and report no failed lane; PKG-like lanes in the same tick are unaffected", async () => {
    const { planFinSync, planFinReports } = await import("@nichols/core/inngest");
    const r = reader(MAIL_ONLY);
    const conn = "22222222-2222-4222-8222-222222222222";
    const deps = {
      enabledLanes: () => ["XX", "YY"],
      listConnections: async (lane: string) => (lane === "YY" ? [conn] : []), // XX: mail-only, no QuickBooks connection; YY: a full lane
      intervalHours: (lane: string) => r.qboSyncIntervalHours(lane as never),
    };
    for (const hour of [0, 4, 7]) {
      const plan = await planFinSync(deps, hour);
      expect(plan.failedLanes, `hour ${String(hour)}`).toEqual([]);
      expect(plan.sends.filter((s) => s.laneId === "XX")).toEqual([]);
    }
    expect((await planFinSync(deps, 4)).sends).toEqual([{ laneId: "YY", connectionId: conn }]);
    const reports = await planFinReports(deps);
    expect(reports.failedLanes).toEqual([]);
    expect(reports.sends).toEqual([{ laneId: "YY", connectionId: conn }]);
    const mailOnly = await planFinSync({ ...deps, enabledLanes: () => ["XX"] }, 4);
    expect(mailOnly).toEqual({ sends: [], failedLanes: [] });
  });

  it("a stored config with an unknown root key still reads fine (readers use narrow views, not the strict whole-config schema)", async () => {
    const r = reader({ ...MAIL_ONLY, some_future_key: { a: 1 } });
    expect(await r.mailProviders("XX")).toEqual(["microsoft"]);
    expect(await r.qboSyncIntervalHours("XX")).toBe(4);
    expect(await r.retentionConfig("XX")).toMatchObject({ webhookDays: 30 });
    expect(await r.mailProviderSettings("XX")).toMatchObject({ providers: ["microsoft"] });
  });
});
