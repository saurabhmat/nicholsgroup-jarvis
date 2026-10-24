#!/usr/bin/env node
// Runs pgTAP (supabase test db) against the LOCAL core stack. Fails closed: non-zero if the stack is down,
// there are no tests, or any test fails. Never uses --linked or a remote URL.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workdir = path.join(root, "supabase", "core");
const testsDir = path.join(workdir, "supabase", "tests");

const fail = (msg) => {
  console.error(`test:db FAILED: ${msg}`);
  process.exit(1);
};

const run = (args, opts = {}) =>
  spawnSync("supabase", [...args, "--workdir", workdir], { cwd: root, encoding: "utf8", ...opts });

let tests = [];
try {
  tests = readdirSync(testsDir).filter((f) => f.endsWith(".sql"));
} catch {
  fail(`cannot read ${testsDir}`);
}
if (tests.length === 0) fail(`no .sql pgTAP tests in ${testsDir}`);

const status = run(["status"]);
if (status.error) fail(`supabase CLI not runnable: ${status.error.message}`);
if (status.status !== 0) fail("local Supabase is not running. Start it with `pnpm db:start`.");

const result = run(["test", "db", "--local"], { stdio: "inherit" });
if (result.error) fail(result.error.message);
if (result.status !== 0) fail(`pgTAP exited with status ${result.status}`);
console.log(`test:db ok (${tests.length} test file(s))`);
