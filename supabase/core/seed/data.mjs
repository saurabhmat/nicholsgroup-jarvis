// Synthetic seed definitions (CLAUDE.md rule 10). The only real-world names allowed here are the lane names.
// People are role personas with "Synthetic ..." labels and emails on the reserved `example.test` domain (RFC 6761),
// which can never receive mail, so these users cannot sign in anywhere except through local test tooling.
import { createRng } from "./rng.mjs";

/** Master seed. Changing it changes every generated id; do it only deliberately and regenerate (`pnpm db:seed`). */
export const SEED = "jarvis-synthetic-seed-v1";

/** Fixed clock for every seeded timestamp (never now()), so the seed SQL is byte-identical on every run. */
export const SEED_EPOCH = "2026-01-01 00:00:00+00";

/** The only email domain seed data may use. */
export const SYNTHETIC_EMAIL_DOMAIN = "example.test";

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
};

/**
 * Lane registry rows (architecture §5.1). Only PKG is enabled during the pilot.
 * T-010 inserts these into `core.lanes` (code, name, data_plane, enabled) from a seed section.
 * @type {ReadonlyArray<{code: string, name: string, dataPlane: "core" | "nl", enabled: boolean}>}
 */
export const LANES = deepFreeze([
  { code: "PKG", name: "Pub K Group", dataPlane: "core", enabled: true },
  { code: "APK", name: "Ask Pub K", dataPlane: "core", enabled: false },
  { code: "PKI", name: "Pub K Institute", dataPlane: "core", enabled: false },
  { code: "NC", name: "Nichols Capital", dataPlane: "core", enabled: false },
  { code: "NL", name: "Nichols Law", dataPlane: "nl", enabled: false },
  { code: "P", name: "Personal", dataPlane: "core", enabled: false },
]);

const ALL_LANES = LANES.map((l) => l.code);

/**
 * Test personas. `memberships` are the intended lane roles for T-012 to seed into `core.memberships`
 * (role ∈ owner / admin_technical / finance_operator / viewer); T-012 may refine them (e.g. viewer named views).
 * The outsider is a signed-up user with no membership: every lane must deny it.
 * Roles are never written to auth metadata; authorization comes from memberships only.
 * @type {ReadonlyArray<{key: string, displayName: string, email: string, memberships: ReadonlyArray<{lane: string, role: string}>}>}
 */
export const PERSONAS = deepFreeze([
  {
    key: "owner",
    displayName: "Synthetic Owner",
    email: `owner@${SYNTHETIC_EMAIL_DOMAIN}`,
    memberships: ALL_LANES.map((lane) => ({ lane, role: "owner" })),
  },
  {
    key: "admin_technical",
    displayName: "Synthetic Admin Technical",
    email: `admin-technical@${SYNTHETIC_EMAIL_DOMAIN}`,
    memberships: [{ lane: "PKG", role: "admin_technical" }],
  },
  {
    key: "finance_operator",
    displayName: "Synthetic Finance Operator",
    email: `finance-operator@${SYNTHETIC_EMAIL_DOMAIN}`,
    memberships: [{ lane: "PKG", role: "finance_operator" }],
  },
  {
    key: "viewer",
    displayName: "Synthetic Viewer",
    email: `viewer@${SYNTHETIC_EMAIL_DOMAIN}`,
    memberships: [{ lane: "PKG", role: "viewer" }],
  },
  {
    key: "outsider",
    displayName: "Synthetic Outsider",
    email: `outsider@${SYNTHETIC_EMAIL_DOMAIN}`,
    memberships: [],
  },
]);

/**
 * Capitalized words allowed inside seed string literals: lane names, lane codes and persona labels.
 * Extend only with clearly synthetic words (reviewed); the guard rejects anything else that looks like a name.
 */
export const ALLOWED_NAME_WORDS = deepFreeze(
  [...new Set([...LANES.flatMap((l) => [l.code, ...l.name.split(" ")]), ...PERSONAS.flatMap((p) => p.displayName.split(" "))])].sort(),
);

/**
 * Everything a seed section may read: lanes and personas with their deterministic ids, and the fixed epoch.
 *
 * Cross-section references: an id that more than one section needs (a lane's id, a persona's user id) lives HERE,
 * derived from a per-entity RNG label (`lane:<code>`, `persona:<key>`), never from a section's own `ctx.rng`.
 * Otherwise reference rows by natural key in SQL (e.g. `(select id from core.lanes where code = 'PKG')`).
 * Per-entity labels mean adding an entity never changes the others' ids. T-010 decides whether `core.lanes` uses
 * `lanes[].id` or the code as its key.
 * @param {string | number} seed
 */
export function buildSeedData(seed) {
  return deepFreeze({
    seed,
    epoch: SEED_EPOCH,
    lanes: LANES.map((l) => ({ ...l, id: createRng(seed, `lane:${l.code}`).uuid() })),
    personas: PERSONAS.map((p) => ({
      ...p,
      memberships: p.memberships.map((m) => ({ ...m })),
      id: createRng(seed, `persona:${p.key}`).uuid(),
    })),
  });
}
