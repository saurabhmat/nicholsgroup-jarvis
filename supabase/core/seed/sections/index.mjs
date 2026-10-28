// Seed section registry. Sections run in this order; put a section after the ones whose rows it references
// (e.g. memberships after lanes and auth-personas). How to add one: see "Seed data" in the root README.
import authPersonas from "./auth-personas.mjs";

/**
 * @typedef {object} SeedContext
 * @property {ReturnType<typeof import("../data.mjs").buildSeedData>} data  lanes, personas (with ids), epoch, seed
 * @property {ReturnType<typeof import("../rng.mjs").createRng>} rng  this section's own deterministic stream
 *
 * @typedef {object} SeedSection
 * @property {string} id           unique, lowercase kebab-case; also names the section's RNG stream
 * @property {string} description  one line, shown as a comment in seed.sql
 * @property {(ctx: SeedContext) => string[]} build  SQL statements, each ending in ';'
 */

/** @type {ReadonlyArray<SeedSection>} */
export const SECTIONS = Object.freeze([
  authPersonas,
  // T-010: lanes (core.lanes from ctx.data.lanes)
  // T-011: lane-config (core.lane_config for PKG, synthetic ids)
  // T-012: users-memberships (core.users / core.memberships from ctx.data.personas[].memberships)
]);
