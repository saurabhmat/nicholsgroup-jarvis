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
    expect(c.teams).toEqual({ enabled: true, cloud: "commercial", tenant_ids: [T], allowed_domains: [D], features: ["chat_read", "call_links"], max_accounts_per_person: 1 });
  });

  it("T-294: the several-accounts template parses with the app's own schema and differs from the plain one only in the number; the number is bounded 1 to 5", () => {
    const raw = /<!-- teams-limit-template -->\s*```json\n([\s\S]*?)```/.exec(readFileSync(RUNBOOK, "utf8"))?.[1];
    expect(raw, "the runbook must carry the several-accounts template").toBeTruthy();
    const several = JSON.parse((raw as string).replaceAll("__TEAMS_TENANT_ID__", T).replaceAll("__TEAMS_DOMAIN__", D)) as { teams: Record<string, unknown> };
    expect(parseLaneConfig(several).teams).toEqual({ ...parseLaneConfig(template()).teams, max_accounts_per_person: 2 });
    for (const n of [1, 5]) expect(parseLaneConfig({ teams: { ...several.teams, max_accounts_per_person: n } }).teams?.max_accounts_per_person).toBe(n);
    for (const n of [0, 6, 2.5, "2", null]) expect(() => parseLaneConfig({ teams: { ...several.teams, max_accounts_per_person: n } }), String(n)).toThrow();
    // a lane config without the key still reads as 1 (every lane keeps today's behaviour until a human version sets it)
    expect(parseLaneConfig({ teams: { enabled: true, tenant_ids: [T], allowed_domains: [D] } }).teams?.max_accounts_per_person).toBe(1);
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

  it("the runbook itself (committed) names the SQL pair, the order and the way back, for the Teams enable step and for the several-accounts step", () => {
    const md = readFileSync(RUNBOOK, "utf8");
    for (const name of ["enable-lane-teams-T-280.sql", "check-enable-lane-teams-T-280.sql", "teams-accounts-limit-H-085.sql", "check-teams-accounts-limit-H-085.sql", "part-37-T-294.sql"]) expect(md, name).toContain(name);
    expect(md).toContain("DEPLOYED");
    expect(md).toMatch(/a new insert-only (settings )?version without the key/); // the way back if the number was set before the deploy
  });

  // The two gitignored operator copies. A copy that is still a TEMPLATE (a placeholder lane) is checked; a copy the operator has FILLED IN (it holds real values) is reported as skipped, visibly,
  // and is never read for its values: this test never passes or fails because of what the operator typed.
  const readIf = (file: string): string | null => (existsSync(join(DIR, file)) ? readFileSync(join(DIR, file), "utf8") : null);
  const enableSql = readIf("enable-lane-teams-T-280.sql");
  const limitSql = readIf("teams-accounts-limit-H-085.sql");
  const limitCheck = readIf("check-teams-accounts-limit-H-085.sql");
  const isTemplate = (sql: string | null) => sql !== null && /constant text\s+:= 'PASTE-LANE-CODE'/.test(sql);

  it.skipIf(!isTemplate(enableSql))("the T-280 SQL (template copy): builds the same block and never edits an existing one", () => {
    const sql = enableSql as string;
    for (const key of ["'enabled', true", "'cloud', 'commercial'", "'tenant_ids'", "'allowed_domains'", "'features'"]) expect(sql).toContain(key);
    expect(sql).toMatch(/v_cur \? 'teams'/);
    expect(sql.replace("9188040d-6c67-4c5b-b112-36a304b66dad", "")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/); // no tenant id but Microsoft's fixed personal-account tenant (refused on purpose)
  });

  it.skipIf(!isTemplate(limitSql) || limitCheck === null || !/'PASTE-LANE-CODE'/.test(limitCheck))("the several-accounts SQL pair (template copies): sets exactly one key, keeps its values in one block, refuses a second run", () => {
    const sql = limitSql as string;
    expect(sql).toMatch(/'\{teams,max_accounts_per_person\}'/);
    expect(sql).toMatch(/\? 'max_accounts_per_person'/); // refuses when the key exists
    expect(sql).toMatch(/v_deployed <> 'DEPLOYED'/);
    // every value is typed once: the lane code appears once in each file
    const lane = /'PASTE-LANE-CODE'[,;]?\s+-- VALUE 1/g;
    expect(sql.match(lane)).toHaveLength(1);
    expect((limitCheck as string).match(lane)).toHaveLength(1);
    expect((sql.match(/v_lane\b/g) ?? []).length).toBeGreaterThan(3); // used by name everywhere else
    // no cast sits on a value line (a value pasted over a ::text cast is how an earlier file broke)
    for (const line of sql.split("\n").filter((l) => /VALUE [123]:/.test(l))) expect(line).not.toMatch(/::/);
  });
});
