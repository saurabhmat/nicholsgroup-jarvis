// Seed templates (T-210). The files live in ../../templates and are bundled into templates.generated.ts by
// scripts/build-templates.mjs. They are created lazily on first use, per lane (Work) or per user in the home lane
// (About-Me, Preferences), through the writers; never by a migration. No Nichols Law documents: the lane router refuses
// the NL lane until its data plane exists, so seeding never reaches it.
import { ABOUT_ME_PATH, PREFERENCES_PATH, WORK_PATH } from "./paths";
import { TEMPLATE_FILES } from "./templates.generated";

export { TEMPLATE_FILES };

const file = (path: string): string => {
  const body = TEMPLATE_FILES[path];
  if (body === undefined) throw new Error(`brain template missing: ${path}`);
  return body;
};

export type SeedDocument = { path: string; body: string };
export type SeedSkill = { key: string; title: string; body: string };

/** Pages created in the user's home lane. */
export const HOME_SEED_DOCUMENTS: readonly SeedDocument[] = [
  { path: ABOUT_ME_PATH, body: file(ABOUT_ME_PATH) },
  { path: PREFERENCES_PATH, body: file(PREFERENCES_PATH) },
];

/** Pages created in every lane the brain is used in. */
export const LANE_SEED_DOCUMENTS: readonly SeedDocument[] = [{ path: WORK_PATH, body: file(WORK_PATH) }];

/** Method prompts, from Skills/<key>/SKILL.md. The title is the key in words. */
export const SEED_SKILLS: readonly SeedSkill[] = Object.keys(TEMPLATE_FILES)
  .map((p) => /^Skills\/([a-z][a-z0-9-]+)\/SKILL\.md$/.exec(p)?.[1])
  .filter((k): k is string => k !== undefined)
  .sort()
  .map((key) => {
    const words = key.replace(/-/g, " ");
    return { key, title: words.charAt(0).toUpperCase() + words.slice(1), body: file(`Skills/${key}/SKILL.md`) };
  });

/** Instructions text for the first employee (T-211 builds the profile around it). */
export const PERSONAL_ASSISTANT_INSTRUCTIONS = file("Employees/Personal-Assistant.md");

/** For "New project" (spec §3). */
export const PROJECT_TEMPLATES = { brief: file("Projects/_template/BRIEF.md"), handoff: file("Projects/_template/HANDOFF.md") } as const;

/** The static prompt section (not a user document); used by prompt assembly in T-212. */
export const BRAIN_RULES_MD = file("AGENTS.md");
