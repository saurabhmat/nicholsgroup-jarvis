// Playwright global setup (T-019): every e2e run starts from the synthetic seed (personas without MFA factors).
// LOCAL only: `supabase db reset --local`, never a linked project.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export default function globalSetup() {
  execFileSync(process.execPath, [path.join(root, "supabase/core/seed/generate.mjs")], { cwd: root, stdio: "ignore" });
  execFileSync("supabase", ["db", "reset", "--local", "--workdir", path.join(root, "supabase/core")], { cwd: root, stdio: "ignore" });
}
