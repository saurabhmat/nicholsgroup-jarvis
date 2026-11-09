// Where an imported fact can land (T-220, spec brain-and-employees §7a). Pure and client-safe.
// The four targets are the pages the setup interview writes (About me, Preferences, Work for the current lane, the Personal
// Assistant profile). `section` is an exact "## " heading of that page, chosen from the fixed lists below: a model (or a zip
// file) can never name another heading, a path or a lane. "Scope" and "Timezone" (checked answers) and the PA's "Rules" and
// "Drafting rules" (what the assistant may do) are not importable.
import { ABOUT_ME_PATH, PREFERENCES_PATH, WORK_PATH } from "../domain/paths";
import { GROUPS, PA_SECTIONS, QUESTIONS } from "../interview/bank";

export const IMPORT_TARGETS = ["about_me", "preferences", "work", "pa"] as const;
export type ImportTarget = (typeof IMPORT_TARGETS)[number];

export const PA_PATH = "Employees/Personal-Assistant.md";

export const IMPORT_SECTIONS: Readonly<Record<ImportTarget, readonly string[]>> = {
  about_me: ["Name and how to address me", "Routine and constraints", "Goals right now", "First task for Jarvis"],
  preferences: ["Writing", "Delivery of information", "Always ask me first", "Never do"],
  work: ["What the company does", "My role here", "Key people", "Priority senders and topics", "Products, clients and current focus", "Terms and conventions"],
  pa: [PA_SECTIONS.role, PA_SECTIONS.priority, PA_SECTIONS.leaveOut, PA_SECTIONS.calendar],
};

export const TARGET_LABEL: Readonly<Record<ImportTarget, string>> = {
  about_me: "About me",
  preferences: "Preferences",
  work: "Work for this company",
  pa: "Personal Assistant profile",
};

const PATHS: Readonly<Record<ImportTarget, string>> = { about_me: ABOUT_ME_PATH, preferences: PREFERENCES_PATH, work: WORK_PATH, pa: PA_PATH };

export const targetPath = (t: ImportTarget): string => PATHS[t];

export function targetFromPath(path: string): ImportTarget | null {
  return IMPORT_TARGETS.find((t) => PATHS[t] === path) ?? null;
}

export const isImportTarget = (v: unknown): v is ImportTarget => typeof v === "string" && (IMPORT_TARGETS as readonly string[]).includes(v);

export const isImportSection = (t: ImportTarget, section: unknown): section is string => typeof section === "string" && IMPORT_SECTIONS[t].includes(section);

/** The lane a target's page lives in: the Work page in the lane the import runs from, the rest in the home lane. */
export const laneFor = (t: ImportTarget, ctx: { home: string; current: string }): string => (t === "work" ? ctx.current : ctx.home);

/**
 * The setup sections (the bank's group ids) that write this page section: a section the user saved a fact into counts as
 * done, the same rule as a Save in the interview (T-227). Sections the bank does not ask about match none.
 */
export function groupsFor(target: ImportTarget, section: string): string[] {
  const questionIds = new Set(QUESTIONS.filter((q) => q.targets.some((x) => x.doc === target && x.section === section)).map((q) => q.id));
  return GROUPS.filter((g) => g.questionIds.some((id) => questionIds.has(id))).map((g) => g.id);
}
