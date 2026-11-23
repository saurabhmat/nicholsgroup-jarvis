// T-278 review C8: the admin-consent sentence and the provider name exist in the connector (constants.ts) and in the web page's fixed wording (apps/web/lib/teams-wording.ts); the two must say the
// same, so a change in one is noticed. (The web app does not import the connector's constants: the connector package is server-side.)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEAMS_ADMIN_CONSENT_TEXT, TEAMS_PROVIDER } from "./constants";

const web = readFileSync(join(__dirname, "../../../../apps/web/lib/teams-wording.ts"), "utf8");
const literal = (name: string) => {
  const m = new RegExp(`export const ${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(web);
  expect(m, name).not.toBeNull();
  return JSON.parse(`"${m?.[1] ?? ""}"`) as string;
};

describe("Teams wording is the same in the connector and the web app", () => {
  it("the admin approval sentence", () => expect(literal("TEAMS_ADMIN_CONSENT_TEXT")).toBe(TEAMS_ADMIN_CONSENT_TEXT));
  it("the provider name", () => expect(literal("TEAMS_PROVIDER")).toBe(TEAMS_PROVIDER));
});
