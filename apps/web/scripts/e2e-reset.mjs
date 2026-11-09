// Playwright global setup (T-019): every e2e run starts from the synthetic seed (personas without MFA factors).
// LOCAL only: `supabase db reset --local`, never a linked project.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearSecrets } from "./e2e-secrets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export default function globalSetup() {
  execFileSync(process.execPath, [path.join(root, "supabase/core/seed/generate.mjs")], { cwd: root, stdio: "ignore" });
  execFileSync("supabase", ["db", "reset", "--local", "--workdir", path.join(root, "supabase/core")], { cwd: root, stdio: "ignore" });
  clearSecrets(); // the reset removed every MFA factor, so secrets from an earlier run are stale
  // The local publishable key (public by design) for the HTTP-level specs; never printed or written to disk.
  const status = spawnSync("supabase", ["status", "-o", "env", "--workdir", path.join(root, "supabase/core")], { encoding: "utf8" });
  const key = /^PUBLISHABLE_KEY="?(.*?)"?$/m.exec(status.stdout)?.[1];
  if (key) process.env.E2E_SUPABASE_PUBLISHABLE_KEY = key;
}
