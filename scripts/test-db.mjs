#!/usr/bin/env node
// Runs pgTAP (supabase test db) against the LOCAL core stack. Fails closed: non-zero if the stack is down,
// there are no tests, the reset fails, or any test fails. Never auto-starts the stack, never uses --linked.
// Usage: node scripts/test-db.mjs [--no-reset]
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workdir = path.join(root, "supabase", "core");
const testsDir = path.join(workdir, "supabase", "tests");
const noReset = process.argv.includes("--no-reset");

const fail = (msg) => {
  console.error(`test:db FAILED: ${msg}`);
  process.exit(1);
};

const run = (args, opts = {}) =>
  spawnSync("supabase", [...args, "--workdir", workdir], { cwd: root, encoding: "utf8", ...opts });

let tests = [];
try {
  tests = readdirSync(testsDir, { recursive: true }).filter((f) => String(f).endsWith(".sql"));
} catch {
  fail(`cannot read ${testsDir}`);
}
if (tests.length === 0) fail(`no .sql pgTAP tests in ${testsDir}`);

// Status stdout contains local keys, so only stderr is ever printed.
const status = run(["status"]);
if (status.error) fail(`supabase CLI not runnable: ${status.error.message}`);
if (status.status !== 0) {
  if (status.stderr) console.error(status.stderr.trim());
  fail("local Supabase is not running. Start it with `pnpm db:start`.");
}

if (!noReset) {
  // The reset applies the committed seed.sql; refuse to test a seed that no longer matches its generator.
  const seedCheck = spawnSync(process.execPath, [path.join(workdir, "seed", "generate.mjs"), "--check"], { cwd: root, stdio: "inherit" });
  if (seedCheck.error) fail(seedCheck.error.message);
  if (seedCheck.status !== 0) fail("seed.sql is out of date. Run `pnpm db:seed`.");

  const reset = run(["db", "reset", "--local"], { stdio: "inherit" });
  if (reset.error) fail(reset.error.message);
  if (reset.status !== 0) fail(`db reset exited with status ${reset.status}`);
}

const result = run(["test", "db", "--local"], { stdio: "inherit" });
if (result.error) fail(result.error.message);
if (result.status !== 0) fail(`pgTAP exited with status ${result.status}`);
console.log(`test:db ok (${tests.length} test file(s))`);
