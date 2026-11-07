// Brain page paths and kinds (T-210, spec §3). These mirror brain.valid_path() and brain.document_kind() in SQL, which
// are authoritative (the kind follows from the path, never from the caller). A test pins the two to the same examples.

export const DOCUMENT_KINDS = ["about_me", "preferences", "context", "project_brief", "project_handoff", "note"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Largest page, employee profile or skill, in bytes (UTF-8). */
export const MAX_BODY_BYTES = 32_768;
export const MAX_PATH_LENGTH = 200;

/** Where the user's own, owner-only pages live (About-Me and Preferences are readable by their author only). */
export const ABOUT_ME_PATH = "Context/About-Me.md";
export const PREFERENCES_PATH = "Context/Preferences.md";
export const WORK_PATH = "Context/Work.md";

const PATH = /^(Context|Projects|Notes)(\/[A-Za-z0-9_-]+){1,5}\.md$/;

export function isValidBrainPath(path: unknown): path is string {
  return typeof path === "string" && path.length <= MAX_PATH_LENGTH && PATH.test(path);
}

export function documentKindFor(path: string): DocumentKind {
  if (path === ABOUT_ME_PATH) return "about_me";
  if (path === PREFERENCES_PATH) return "preferences";
  if (path.startsWith("Context/")) return "context";
  if (/^Projects\/[A-Za-z0-9_-]+\/BRIEF\.md$/.test(path)) return "project_brief";
  if (/^Projects\/[A-Za-z0-9_-]+\/HANDOFF\.md$/.test(path)) return "project_handoff";
  return "note";
}

/** Kinds only their author may read, even for other owners of the same lane. */
export const OWNER_ONLY_KINDS: readonly DocumentKind[] = ["about_me", "preferences"];

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
