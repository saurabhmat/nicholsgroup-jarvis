// T-170: the security suite cannot be silently dropped. Every file in the manifest exists, vitest files sit where their package's
// vitest config picks them up (so `pnpm test` runs them), the pgTAP files sit in the pgTAP folder (so `pnpm test:db` runs them),
// and every pgTAP file named *security* is in the manifest.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
