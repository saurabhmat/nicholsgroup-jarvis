// T-170: runs the vitest half of the pilot security suite on its own (scripts/security-suite.json). The pgTAP half is part of
// `pnpm test:db`; pass --db to run it too (this wipes nothing with --no-reset, which is what --db uses).
// Usage: node scripts/test-security.mjs [--db]
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./lib-workspaces.mjs";

const manifest = JSON.parse(readFileSync(join(ROOT, "scripts/security-suite.json"), "utf8"));
let failed = false;
for (const [pkg, files] of Object.entries(manifest.vitest)) {
  const r = spawnSync("pnpm", ["exec", "vitest", "run", ...files], { cwd: join(ROOT, pkg), stdio: "inherit" });
  if (r.status !== 0) failed = true;
}
if (process.argv.includes("--db")) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/test-db.mjs"), "--no-reset"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
