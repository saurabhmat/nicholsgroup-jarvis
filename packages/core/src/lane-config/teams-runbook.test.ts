// T-280: the `teams` block the runbook (docs/runbooks/enable-lane-mail.md, "Enable Teams for a company") shows is accepted by the app's own schema, on top of a Google-mail lane, a
// Microsoft-mail lane and a mail-only limited lane, and nothing else of those lanes changes. The gitignored SQL pair is checked too when it is present on this machine.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLaneConfig } from "./index";

const REPO = join(__dirname, "..", "..", "..", "..");
const RUNBOOK = join(REPO, "docs", "runbooks", "enable-lane-mail.md");
const DIR = join(REPO, "supabase", "core", "bootstrap", "manual-migrations");
const T = "11111111-2222-4333-8444-555555555555";
const D = "teams.example.test";
const template = () => {
  const raw = /<!-- teams-config-template -->\s*```json\n([\s\S]*?)```/.exec(readFileSync(RUNBOOK, "utf8"))?.[1];
  expect(raw, "the runbook must carry the teams template").toBeTruthy();
  return JSON.parse((raw as string).replaceAll("__TEAMS_TENANT_ID__", T).replaceAll("__TEAMS_DOMAIN__", D)) as { teams: Record<string, unknown> };
};

describe("Enable Teams runbook", () => {
  it("the template parses and says what the runbook says", () => {
    const c = parseLaneConfig(template());
    expect(c.teams).toEqual({ enabled: true, cloud: "commercial", tenant_ids: [T], allowed_domains: [D], features: ["chat_read", "call_links"] });
  });

  it("added to a Google-mail lane, a Microsoft-mail lane and a limited mail-only lane it changes nothing else", () => {
    const bases: Record<string, unknown>[] = [
      { mail: { providers: ["google"] }, mailboxes: ["a@example.test"] },
      { mail: { providers: ["microsoft"], allowed_domains: ["mail.example.test"] }, microsoft: { tenant_ids: [T] } },
      { enabled_modules: ["comms", "calendar", "briefing", "messages"], limit_to_enabled_modules: true, mail: { providers: ["microsoft"], allowed_domains: ["mail.example.test"] }, microsoft: { tenant_ids: [T] } },
    ];
    for (const base of bases) {
      const before = parseLaneConfig(base);
      const after = parseLaneConfig({ ...base, ...template() });
      const { teams, ...rest } = after;
      expect(teams?.enabled).toBe(true);
      expect(rest).toEqual(before);
    }
  });

  it("the SQL pair (gitignored; checked only where present) builds the same block and never edits an existing one", () => {
    const run = join(DIR, "enable-lane-teams-T-280.sql");
    const check = join(DIR, "check-enable-lane-teams-T-280.sql");
    if (!existsSync(run) || !existsSync(check)) return;
    const sql = readFileSync(run, "utf8");
    for (const key of ["'enabled', true", "'cloud', 'commercial'", "'tenant_ids'", "'allowed_domains'", "'features'"]) expect(sql).toContain(key);
    expect(sql).toMatch(/v_cur \? 'teams'/);
    expect(sql).toMatch(/PASTE-LANE-CODE/);
    expect(sql.replace("9188040d-6c67-4c5b-b112-36a304b66dad", "")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/); // no tenant id but Microsoft's fixed personal-account tenant (refused on purpose) is in the file
    expect(readFileSync(check, "utf8")).toMatch(/PASTE-LANE-CODE/);
  });
});
