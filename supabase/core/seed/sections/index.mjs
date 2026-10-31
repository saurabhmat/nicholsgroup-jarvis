// Seed section registry. Sections run in this order; put a section after the ones whose rows it references
// (e.g. memberships after lanes and auth-personas). How to add one: see "Seed data" in the root README.
import authPersonas from "./auth-personas.mjs";
import lanes from "./lanes.mjs";

/**
 * @typedef {object} SeedContext
 * @property {ReturnType<typeof import("../data.mjs").buildSeedData>} data  lanes, personas (with ids), epoch, seed
 * @property {ReturnType<typeof import("../rng.mjs").createRng>} rng  this section's own deterministic stream
 *
 * @typedef {object} SeedSection
 * @property {string} id           unique, lowercase kebab-case; also names the section's RNG stream
 * @property {string} description  one line, no control characters, shown as a comment in seed.sql
 * @property {(ctx: SeedContext) => string[]} build  SQL statements, each ending in ';'
 *
 * Rules for build():
 * - Every literal comes from lit() / json() / values() in sql.mjs. Dollar quoting, E'' and U&'' are rejected.
 * - Set EVERY column that has a now()/random default (created_at, updated_at, id, ...) explicitly from
 *   ctx.data.epoch / ctx.rng. Column defaults are invisible to the generator, so leaving one out makes the database
 *   contents differ between resets even though seed.sql is byte-identical. now(), random(), gen_random_uuid(),
 *   'now'::timestamptz, 'today' and similar are rejected.
 * - Ids another section needs come from ctx.data (per-entity labels in data.mjs), never from this section's
 *   ctx.rng; otherwise reference rows by natural key in SQL. See buildSeedData() in data.mjs.
 */

/** @type {ReadonlyArray<SeedSection>} */
export const SECTIONS = Object.freeze([
  authPersonas,
  lanes,
  // T-011: lane-config (core.lane_config for PKG, synthetic ids)
  // T-012: users-memberships (core.users / core.memberships from ctx.data.personas[].memberships)
]);
