// T-265: a lane with mail and calendar only. The config below is the shape docs/runbooks/enable-lane-mail.md and its manual SQL part write
// (synthetic tenant id and an example.test domain). If the app refuses it, a human must never insert it, so it is parsed here.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES, moduleVisible, parseLaneConfig } from "./index";

const SYNTHETIC_TENANT = "11111111-2222-4333-8444-555555555555";
const SYNTHETIC_DOMAIN = "mail-only.example.test";

/** Substitutes the runbook's two placeholders into a config template. */
const fillTemplate = (template: string) => JSON.parse(template.replaceAll("__MAIL_DOMAIN__", SYNTHETIC_DOMAIN).replaceAll("__TENANT_ID__", SYNTHETIC_TENANT)) as unknown;

const REPO = join(__dirname, "..", "..", "..", "..");
const RUNBOOK = join(REPO, "docs", "runbooks", "enable-lane-mail.md");
const SQL = join(REPO, "supabase", "core", "bootstrap", "manual-migrations", "enable-lane-mail-T-265.sql");
const CHECK = join(REPO, "supabase", "core", "bootstrap", "manual-migrations", "check-enable-lane-mail-T-265.sql");

/** The text between `$cfg$` markers (SQL) or the first ```json fence after the marker line (runbook). */
const fromSql = (text: string) => /\$cfg\$([\s\S]*?)\$cfg\$/.exec(text)?.[1] ?? null;
const fromRunbook = (text: string) => /<!-- lane-config-template -->\s*```json\n([\s\S]*?)```/.exec(text)?.[1] ?? null;

describe("mail-only lane config (T-265)", () => {
  it("the runbook's template parses with the app's schema and has the intended meaning", () => {
    const tpl = fromRunbook(readFileSync(RUNBOOK, "utf8"));
    expect(tpl, "runbook must carry the lane-config template").not.toBeNull();
    const config = parseLaneConfig(fillTemplate(tpl as string));
    expect(config.enabled_modules).toEqual(["comms", "calendar", "briefing"]);
    expect(config.limit_to_enabled_modules).toBe(true);
    expect(config.mail.providers).toEqual(["microsoft"]);
    expect(config.mail.allowed_domains).toEqual([SYNTHETIC_DOMAIN]);
    expect(config.microsoft).toMatchObject({ cloud: "commercial", tenant_ids: [SYNTHETIC_TENANT], allow_gcc: false });
    // Nothing finance-like, no writes, no schedules: those stay off until a human turns them on.
    expect(config.qbo).toBeUndefined();
    expect(config.stripe).toBeUndefined();
    expect(config.ghl).toBeUndefined();
    expect(config.kpis).toEqual([]);
    expect(config.news.enabled).toBe(false);
    expect(config.briefing.schedule_enabled).toBe(false);
    expect(config.approvals.approvals_live).toBe(false);
    expect(config.mailboxes).toEqual([]);
  });

  it("the runbook's Google-only and both-providers variants also parse", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    for (const [marker, providers] of [["google", ["google"]], ["both", ["google", "microsoft"]]] as const) {
      const block = new RegExp(`<!-- lane-config-variant-${marker} -->\\s*\`\`\`json\\n([\\s\\S]*?)\`\`\``).exec(text)?.[1];
      expect(block, `variant ${marker}`).toBeTruthy();
      const config = parseLaneConfig(fillTemplate(block as string));
      expect(config.mail.providers).toEqual(providers);
      expect(config.limit_to_enabled_modules).toBe(true);
    }
  });

  // The SQL files are gitignored (they hold the lane code, tenant id and addresses in a real run), so this part runs only where they exist.
  const hasSql = existsSync(SQL) && existsSync(CHECK);
  it.skipIf(!hasSql)("the manual SQL part and its check carry exactly the runbook's template", () => {
    const rb = (fromRunbook(readFileSync(RUNBOOK, "utf8")) as string).replace(/\s+/g, "");
    expect((fromSql(readFileSync(SQL, "utf8")) as string).replace(/\s+/g, "")).toBe(rb);
    expect((fromSql(readFileSync(CHECK, "utf8")) as string).replace(/\s+/g, "")).toBe(rb);
  });
  it.skipIf(!hasSql)("the SQL files contain placeholders only (no tenant id, no address, no real domain)", () => {
    for (const file of [SQL, CHECK]) {
      // Microsoft's fixed ids (the nil id and the personal-account tenant) are public constants the SQL refuses; they are not company data.
      const text = readFileSync(file, "utf8").replaceAll("00000000-0000-0000-0000-000000000000", "").replaceAll("9188040d-6c67-4c5b-b112-36a304b66dad", "");
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(text).not.toMatch(/[A-Za-z0-9._-]+@(?!example\.test)[A-Za-z0-9.-]+\.[a-z]{2,}/);
      expect(text).toContain("PASTE-");
    }
  });

  it("a module is visible unless the lane limits itself to its list", () => {
    const limited = { enabled_modules: ["comms", "calendar", "briefing"], limit_to_enabled_modules: true };
    for (const m of MODULES) expect(moduleVisible({ enabled_modules: ["comms"] }, m), `unlimited lane shows ${m}`).toBe(true);
    expect(MODULES.filter((m) => moduleVisible(limited, m))).toEqual(["briefing", "comms", "calendar"]);
    expect(moduleVisible(limited, "finance")).toBe(false);
    expect(moduleVisible({ limit_to_enabled_modules: true }, "comms")).toBe(false); // limited with an empty list shows nothing optional
    // unreadable or malformed: not limited (this only hides screens)
    for (const bad of [null, undefined, "x", 3, [], { limit_to_enabled_modules: "true", enabled_modules: [] }]) expect(moduleVisible(bad, "finance")).toBe(true);
    expect(moduleVisible({ limit_to_enabled_modules: true, enabled_modules: "comms" }, "comms")).toBe(false);
  });

  it("limit_to_enabled_modules must be a boolean and defaults to false", () => {
    expect(parseLaneConfig({}).limit_to_enabled_modules).toBe(false);
    expect(() => parseLaneConfig({ limit_to_enabled_modules: "yes" })).toThrow();
  });
});
