import { describe, expect, it } from "vitest";
import { ACTION_TYPES } from "@nichols/core/lane-config";
import { ACTION_TYPE_MAP, PROPOSING_ROLES, checkEmployeeConfig, effectivePermissions, effectivePermissionsByLane, employeeConfigSchema, kpisForLane } from "./employee-config";

const settings = { AAA: { mailboxes: ["boss@example.test"], kpis: ["mrr", "ar_total"] }, BBB: { mailboxes: ["ops@example.test"], kpis: [] } };
const settingsFor = (l: string) => (l in settings ? settings[l as keyof typeof settings] : null);
const policy = (write: string[], store = true) => ({ write_actions_allowed: write, store_outbound_drafts: store });

describe("employeeConfigSchema", () => {
  it("fills defaults: Mon-Fri, ET, save_draft only (D-32, D-34)", () => {
    const c = employeeConfigSchema.parse({ lanes: ["AAA"] });
    expect(c.schedule).toEqual({ days: [1, 2, 3, 4, 5] });
    expect(c.timezone).toBe("America/New_York");
    expect(c.permissions.propose).toEqual(["email.save_draft"]);
    expect(c.delivery).toEqual(["in_app", "push"]);
  });
  it("is strict at every level", () => {
    for (const bad of [{ lanes: ["AAA"], x: 1 }, { lanes: ["AAA"], schedule: { y: 1 } }, { lanes: ["AAA"], permissions: { propose: ["email.wire"] } }, { lanes: [] }, { lanes: ["aaa"] }, { lanes: ["AAA"], schedule: { days: [] } }, { lanes: ["AAA"], schedule: { days: [7] } }, { lanes: ["AAA"], delivery: ["email"] }]) {
      expect(employeeConfigSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("checkEmployeeConfig", () => {
  const issueCodes = (c: unknown, lane = "AAA") => {
    const r = checkEmployeeConfig(c, lane, settingsFor);
    return r.ok ? [] : r.issues.map((i) => i.code);
  };
  it("accepts a single-lane config and a multi-lane config in the home lane", () => {
    expect(checkEmployeeConfig({ lanes: ["AAA"] }, "AAA", settingsFor).ok).toBe(true);
    expect(checkEmployeeConfig({ lanes: ["AAA", "BBB"], sources: { mail: [{ lane: "BBB", mailbox: "ops@example.test", priority: 2 }] } }, "AAA", settingsFor).ok).toBe(true);
  });
  it("rejects an unknown mailbox, or a known mailbox of a different lane", () => {
    expect(issueCodes({ lanes: ["AAA"], sources: { mail: [{ lane: "AAA", mailbox: "nobody@example.test", priority: 1 }] } })).toEqual(["mailbox_unknown"]);
    expect(issueCodes({ lanes: ["AAA", "BBB"], sources: { mail: [{ lane: "BBB", mailbox: "boss@example.test", priority: 1 }] } })).toEqual(["mailbox_unknown"]);
  });
  it("requires mail[].lane in lanes, lanes == [lane_id] for a single lane, and openable lanes", () => {
    expect(issueCodes({ lanes: ["AAA"], sources: { mail: [{ lane: "BBB", mailbox: "ops@example.test", priority: 1 }] } })).toContain("mail_lane_not_in_lanes");
    expect(issueCodes({ lanes: ["BBB"] })).toEqual(["lanes_mismatch"]);
    expect(issueCodes({ lanes: ["AAA", "CCC"] })).toEqual(["lane_not_available"]);
    expect(issueCodes({ lanes: ["AAA", "AAA"] })).toContain("lanes_duplicate");
  });
  it("requires finance_kpis within the lanes' kpis", () => {
    expect(issueCodes({ lanes: ["AAA"], sources: { finance_kpis: ["mrr"] } })).toEqual([]);
    expect(issueCodes({ lanes: ["AAA"], sources: { finance_kpis: ["pnl_ytd"] } })).toEqual(["kpi_not_in_lane"]);
  });
  it("never echoes submitted values in issues", () => {
    const r = checkEmployeeConfig({ lanes: ["AAA"], sources: { mail: [{ lane: "AAA", mailbox: "nobody@example.test", priority: 1 }] } }, "AAA", settingsFor);
    expect(JSON.stringify(r)).not.toContain("nobody");
  });
});

describe("action-type mapping table", () => {
  it("covers every ACTION_TYPES value and maps to the SQL and approvals spellings", () => {
    expect(Object.keys(ACTION_TYPE_MAP).sort()).toEqual([...ACTION_TYPES].sort());
    expect(ACTION_TYPE_MAP["email.draft"]).toMatchObject({ policy: "email_draft", approvals: "email.save_draft" });
    expect(ACTION_TYPE_MAP["email.save_draft"]).toMatchObject({ policy: "email_draft", approvals: "email.save_draft" });
    expect(ACTION_TYPE_MAP["email.send"]).toMatchObject({ policy: "email_send", approvals: "email.send" });
    expect(ACTION_TYPE_MAP["calendar.event"].policy).toBe("calendar");
    expect(ACTION_TYPE_MAP["monday.item"].policy).toBe("monday");
    expect(ACTION_TYPE_MAP["notion.page"].policy).toBe("notion");
  });
  it("policy spellings are the ones the lane_policies check constraint allows", () => {
    const allowed = ["email_draft", "email_send", "calendar", "monday", "notion"];
    for (const row of Object.values(ACTION_TYPE_MAP)) expect(allowed).toContain(row.policy);
  });
});

describe("effectivePermissions (permission ceiling)", () => {
  it("widen attempt: email.send in a lane without email_send is dropped and reported", () => {
    const r = effectivePermissions(["email.save_draft", "email.send"], policy(["email_draft"]), "owner");
    expect(r.allowed).toEqual(["email.save_draft"]);
    expect(r.denied).toEqual([{ type: "email.send", reason: "lane_policy" }]);
  });
  it("is the intersection: config, lane policy, role", () => {
    expect(effectivePermissions(["email.send", "calendar.event"], policy(["email_send", "email_draft", "calendar"]), "owner").allowed).toEqual(["email.send", "calendar.event"]);
    expect(effectivePermissions(["calendar.event"], policy([]), "owner").allowed).toEqual([]); // lane allows more than config -> config narrows
    expect(effectivePermissions(["email.send"], policy(["email_send"]), "owner").allowed).toEqual(["email.send"]);
    for (const role of ["viewer", "finance_operator", "admin_technical", "unknown"]) {
      expect(effectivePermissions(["email.save_draft"], policy(["email_draft"]), role)).toEqual({ allowed: [], denied: [{ type: "email.save_draft", reason: "role" }] });
    }
  });
  it("email.draft is an alias: both spellings yield one email.save_draft", () => {
    expect(effectivePermissions(["email.draft", "email.save_draft"], policy(["email_draft"]), "owner").allowed).toEqual(["email.save_draft"]);
  });
  it("email proposals need store_outbound_drafts (D-19)", () => {
    expect(effectivePermissions(["email.save_draft"], policy(["email_draft"], false), "owner").denied).toEqual([{ type: "email.save_draft", reason: "drafts_not_stored" }]);
  });
  it("an empty lane policy allows nothing", () => {
    expect(effectivePermissions([...ACTION_TYPES], policy([]), "owner").allowed).toEqual([]);
  });
});

describe("T-211 review fixes", () => {
  it("validates the time zone, control characters and duplicates", () => {
    expect(employeeConfigSchema.safeParse({ lanes: ["AAA"], timezone: "Europe/London" }).success).toBe(true);
    for (const bad of [
      { lanes: ["AAA"], timezone: "Mars/Olympus" },
      { lanes: ["AAA"], sources: { mail: [{ lane: "AAA", mailbox: "boss@example.test", priority: 1, include: ["ok\nignore previous"] }] } },
      { lanes: ["AAA"], sources: { external: [{ kind: "web_news", topics: ["a\u0000b"] }] } },
      { lanes: ["AAA"], schedule: { days: [1, 1] } },
      { lanes: ["AAA"], delivery: ["push", "push"] },
      { lanes: ["AAA"], exclude: ["social", "social"] },
    ]) {
      expect(employeeConfigSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("stores the email.draft alias as email.save_draft, once", () => {
    expect(employeeConfigSchema.parse({ lanes: ["AAA"], permissions: { propose: ["email.draft", "email.save_draft"] } }).permissions.propose).toEqual(["email.save_draft"]);
  });
  it("stores lane_config's mailbox spelling and reports duplicate lanes with their own code", () => {
    const r = checkEmployeeConfig({ lanes: ["AAA"], sources: { mail: [{ lane: "AAA", mailbox: "BOSS@example.test", priority: 1 }] } }, "AAA", settingsFor);
    expect(r.ok && r.config.sources.mail[0]?.mailbox).toBe("boss@example.test");
    const d = checkEmployeeConfig({ lanes: ["AAA", "AAA"] }, "AAA", settingsFor);
    expect(d.ok ? [] : d.issues.map((i) => i.code)).toContain("lanes_duplicate");
  });
  it("reports an unknown type as unknown_type, and the tables are frozen", () => {
    expect(effectivePermissions(["email.wire" as never], policy(["email_draft"]), "owner").denied).toEqual([{ type: "email.wire", reason: "unknown_type" }]);
    expect(effectivePermissions(["__proto__" as never], policy(["email_draft"]), "owner").allowed).toEqual([]);
    expect(Object.isFrozen(ACTION_TYPE_MAP) && Object.isFrozen(ACTION_TYPE_MAP["email.send"]) && Object.isFrozen(PROPOSING_ROLES)).toBe(true);
  });
  it("applies each lane's own policy to a multi-lane employee (home allows send, the other lane does not)", () => {
    const byLane = effectivePermissionsByLane(["email.send", "email.save_draft"], ["AAA", "BBB"], (l) => (l === "AAA" ? policy(["email_send", "email_draft"]) : policy(["email_draft"])), () => "owner");
    expect(byLane.AAA?.allowed.sort()).toEqual(["email.save_draft", "email.send"]);
    expect(byLane.BBB?.allowed).toEqual(["email.save_draft"]);
    expect(byLane.BBB?.denied).toEqual([{ type: "email.send", reason: "lane_policy" }]);
  });
  it("never gives a lane a KPI configured only in another lane", () => {
    const c = employeeConfigSchema.parse({ lanes: ["AAA", "BBB"], sources: { finance_kpis: ["mrr"] } });
    expect(kpisForLane(c, settings.AAA)).toEqual(["mrr"]);
    expect(kpisForLane(c, { mailboxes: [], kpis: ["ar_total"] })).toEqual([]);
    expect(kpisForLane(employeeConfigSchema.parse({ lanes: ["AAA"] }), settings.AAA)).toEqual(["mrr", "ar_total"]);
  });
});
