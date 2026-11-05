// Runs synthetic seed SQL in the LOCAL Supabase database container for the Playwright specs (T-199). Local only.
import { execFileSync } from "node:child_process";

const DB_CONTAINER = "supabase_db_nichols-jarvis-core"; // project id in supabase/core/supabase/config.toml

/** @param {string} statement */
export function sql(statement) {
  execFileSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], { input: statement, stdio: ["pipe", "ignore", "inherit"] });
}
