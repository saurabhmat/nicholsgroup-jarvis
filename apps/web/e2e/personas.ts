// Seeded personas per Playwright project: MFA enrolment persists for the run, so projects never share a persona
// that a test enrols. Sign-in-only tests (no enrolment) may use any persona.
import type { TestInfo } from "@playwright/test";

const BY_PROJECT: Record<string, { member: string; secondMember: string }> = {
  desktop: { member: "owner@example.test", secondMember: "viewer@example.test" },
  iphone: { member: "finance-operator@example.test", secondMember: "admin-technical@example.test" },
};

export function personas(info: TestInfo) {
  const p = BY_PROJECT[info.project.name];
  if (!p) throw new Error(`no personas for project ${info.project.name}`);
  return p;
}
