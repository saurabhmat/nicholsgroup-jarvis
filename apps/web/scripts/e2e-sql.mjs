// Runs synthetic seed SQL in the LOCAL Supabase database container for the Playwright specs (T-199). Local only.
import { execFileSync } from "node:child_process";

const DB_CONTAINER = "supabase_db_nichols-jarvis-core"; // project id in supabase/core/supabase/config.toml

/** @param {string} statement */
export function sql(statement) {
  execFileSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], { input: statement, stdio: ["pipe", "ignore", "inherit"] });
}

/**
 * H-042: every brain row in one lane (pages and their versions, employee profiles, skills, imports, T-227 section
 * completions), so each spec starts with nothing set up. The synthetic seed has no brain rows, so this is the seeded
 * state. LOCAL database only; the lane is a code like "PKG", checked before it is put into the SQL.
 * @param {string} lane
 */
export function resetBrain(lane) {
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(lane)) throw new Error("resetBrain: not a lane code");
  sql(`begin;
delete from brain.section_completions where lane_id = '${lane}';
delete from brain.import_candidates where lane_id = '${lane}';
delete from brain.imports where lane_id = '${lane}';
delete from brain.skills where lane_id = '${lane}';
delete from brain.employees where lane_id = '${lane}';
delete from brain.documents where lane_id = '${lane}';
commit;`);
}
