// Playwright global setup (T-019): every e2e run starts from the synthetic seed (personas without MFA factors).
// LOCAL only: `supabase db reset --local`, never a linked project.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearSecrets } from "../e2e/secrets.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** @param {import("@playwright/test").FullConfig} config */
export default function globalSetup(config) {
  execFileSync(process.execPath, [path.join(root, "supabase/core/seed/generate.mjs")], { cwd: root, stdio: "ignore" });
  execFileSync("supabase", ["db", "reset", "--local", "--workdir", path.join(root, "supabase/core")], { cwd: root, stdio: "ignore" });
  // The reset removed every MFA factor, so secrets from an earlier run are stale (every project shares the default
  // output folder; clear each one anyway). Called without a config (docs/runbooks/qbo-sandbox-run.md): nothing to clear.
  for (const dir of new Set((config?.projects ?? []).map((p) => p.outputDir))) clearSecrets(dir);
  // SHOTS_SEED=1 (T-235 screenshots only): load the SYNTHETIC Home fixture (example.test mail and calendar rows) into the
  // freshly reset LOCAL database, through the local docker container. Never set for e2e:brain runs.
  if (process.env.SHOTS_SEED === "1") {
    const sql = readFileSync(path.join(root, "apps/web/e2e/fixtures/home-shots.sql"), "utf8");
    execFileSync("docker", ["exec", "-i", "supabase_db_nichols-jarvis-core", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], { input: sql, stdio: ["pipe", "ignore", "inherit"] });
  }
  // The local publishable key (public by design) for the HTTP-level specs; never printed or written to disk.
  const status = spawnSync("supabase", ["status", "-o", "env", "--workdir", path.join(root, "supabase/core")], { encoding: "utf8" });
  const key = /^PUBLISHABLE_KEY="?(.*?)"?$/m.exec(status.stdout)?.[1];
  if (key) process.env.E2E_SUPABASE_PUBLISHABLE_KEY = key;
}
