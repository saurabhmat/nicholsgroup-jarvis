// T-170: the security suite cannot be silently dropped. Every file in the manifest exists, vitest files sit where their package's
// vitest config picks them up (so `pnpm test` runs them), the pgTAP files sit in the pgTAP folder (so `pnpm test:db` runs them),
// and every pgTAP file named *security* is in the manifest.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./lib-workspaces.mjs";

const manifest = JSON.parse(readFileSync(join(ROOT, "scripts/security-suite.json"), "utf8"));
const TESTS = join(ROOT, "supabase/core/supabase/tests");

test("every vitest file in the manifest exists, is a .test.ts file, and is not under an excluded folder", () => {
  for (const [pkg, files] of Object.entries(manifest.vitest)) {
    for (const f of files) {
      assert.ok(existsSync(join(ROOT, pkg, f)), `${pkg}/${f} missing`);
      assert.match(f, /\.test\.ts$/);
      assert.ok(!f.startsWith("tests/bundle/") && !f.includes("node_modules"), f);
    }
  }
});
test("every pgTAP file in the manifest exists in the pgTAP folder, and every *security* pgTAP file is listed", () => {
  for (const f of manifest.pgtap) assert.ok(existsSync(join(TESTS, f)), `${f} missing`);
  const onDisk = readdirSync(TESTS).filter((f) => /security.*\.test\.sql$/.test(f)).sort();
  assert.deepEqual(onDisk, [...manifest.pgtap].sort());
});
test("the root package.json runs the suite (test:security) and `test` includes this file", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["test:security"], "node scripts/test-security.mjs");
  assert.match(pkg.scripts.test, /scripts\/security-suite\.test\.mjs/);
});

// A vitest file that says it belongs to the suite (marker comment) must be in the manifest, so dropping a file from the manifest fails `pnpm test`.
const MARKER = "T-170 (security suite)";
const SKIP = new Set(["node_modules", "dist", ".next", ".next-e2e", ".next-canary", ".turbo", ".git", "test-results", "coverage"]);
const walk = (dir) => readdirSync(dir).flatMap((n) => (SKIP.has(n) ? [] : statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
test("every vitest file carrying the suite marker is in the manifest, and every manifest file carries it or is a reviewed older test", () => {
  const listed = new Set(Object.entries(manifest.vitest).flatMap(([pkg, files]) => files.map((f) => `${pkg}/${f}`)));
  const marked = [...walk(join(ROOT, "apps")), ...walk(join(ROOT, "packages"))]
    .filter((f) => /\.test\.tsx?$/.test(f) && readFileSync(f, "utf8").slice(0, 800).includes(MARKER))
    .map((f) => f.slice(ROOT.length + 1))
    .sort();
  assert.ok(marked.length >= 9, "the scan finds the suite files");
  assert.deepEqual(marked.filter((f) => !listed.has(f)), []);
  const OLDER = new Set(["packages/connectors/src/vault/canary.test.ts", "packages/ai/src/injection/injection.test.ts"]); // earlier tests the suite runs too
  // behaviour tests cited as proof by the route inventory are part of the command too
  const inventory = readFileSync(join(ROOT, "apps/web/tests/route-inventory.test.ts"), "utf8");
  for (const f of listed) assert.ok(marked.includes(f) || OLDER.has(f) || inventory.includes(f.split("/").slice(-2).join("/")), `${f} is neither marked, cited by the route inventory, nor a reviewed older test`);
});
test("every pgTAP file that says it is part of the suite is listed, and the SQL helper it includes exists", () => {
  for (const f of readdirSync(TESTS).filter((n) => n.endsWith(".test.sql") && readFileSync(join(TESTS, n), "utf8").slice(0, 300).includes(MARKER))) assert.ok(manifest.pgtap.includes(f), `${f} is not in the manifest`);
  assert.ok(existsSync(join(TESTS, "helpers/seed_rows.psql")));
});
