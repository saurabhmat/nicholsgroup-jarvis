// Policy test: no source file may switch off a nichols boundary rule or all rules, by directive or inline config
// comment (security review H1). The ESLint comment rules catch directives at lint time; this grep also catches
// inline CONFIG comments (`/* eslint nichols/x: off */`), which no ESLint rule covers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./lib-workspaces.mjs";

// Files that must spell the patterns out: this test and the fixtures that prove the guards work (exact paths).
const EXCLUDED = new Set([
  "scripts/no-lint-bypass.test.mjs",
  "packages/eslint-plugin/src/config.test.js",
  "packages/eslint-plugin/src/config-web.test.js",
]);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const PATTERNS = [
  [/eslint-disable[^\n]*nichols\//, "eslint-disable directive naming a nichols rule"],
  [/\/\*\s*eslint\s+[^*]*nichols\//, "inline eslint config comment naming a nichols rule"],
  [/\/\*\s*eslint-disable\s*\*\//, "blanket /* eslint-disable */"],
  [/eslint-disable-(?:next-)?line\s*(?:\*\/)?\s*$/m, "blanket eslint-disable-line without rule names"],
];

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && SOURCE.test(f) && !EXCLUDED.has(f));

test("there are tracked source files to scan", () => {
  assert.ok(tracked.length > 20);
});

test("no tracked source file disables a nichols rule or all rules", () => {
  const hits = [];
  for (const file of tracked) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const [pattern, what] of PATTERNS) if (pattern.test(text)) hits.push(`${file}: ${what}`);
  }
  assert.deepEqual(hits, []);
});

test("the patterns catch what they are meant to", () => {
  assert.ok(PATTERNS[0][0].test("// eslint-disable-next-line nichols/no-vendor-sdk"));
  assert.ok(PATTERNS[0][0].test("/* eslint-disable no-console, nichols/no-process-env */"));
  assert.ok(PATTERNS[1][0].test("/* eslint nichols/no-vendor-sdk: off */"));
  assert.ok(PATTERNS[1][0].test("/*eslint no-console: 0, nichols/no-process-env: 0 */"));
  assert.ok(PATTERNS[2][0].test("/* eslint-disable */"));
  assert.ok(PATTERNS[3][0].test("foo(); // eslint-disable-line"));
  assert.ok(!PATTERNS[3][0].test("// eslint-disable-next-line @typescript-eslint/no-explicit-any"));
});
