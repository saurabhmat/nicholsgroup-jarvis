// Every tsconfig in the repo must resolve (through `extends`) to the strict flags of tsconfig.base.json,
// so no package or app can quietly opt out. Run by `pnpm test` (node:test).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = {
  strict: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  forceConsistentCasingInFileNames: true,
  isolatedModules: true,
};
const SKIP = new Set(["node_modules", ".next", "dist", ".git", ".turbo", ".agent"]);

function findTsconfigs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIP.has(entry.name)) findTsconfigs(join(dir, entry.name), out);
    else if (entry.isFile() && /^tsconfig(\..+)?\.json$/.test(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}

/** compilerOptions after following the `extends` chain (relative paths only; none of ours use packages). */
function effectiveOptions(file) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  const inherited = json.extends ? effectiveOptions(resolve(dirname(file), json.extends)) : {};
  return { ...inherited, ...json.compilerOptions };
}

const files = findTsconfigs(ROOT);

test("finds the tsconfig files we expect", () => {
  const rel = files.map((f) => f.slice(ROOT.length + 1));
  for (const expected of ["tsconfig.base.json", "apps/web/tsconfig.json", "packages/core/tsconfig.json", "packages/connectors/tsconfig.json", "packages/eslint-plugin/tsconfig.json"]) {
    assert.ok(rel.includes(expected), `missing ${expected}`);
  }
});

for (const file of files) {
  test(`${file.slice(ROOT.length + 1)} is strict`, () => {
    const options = effectiveOptions(file);
    for (const [flag, value] of Object.entries(REQUIRED)) {
      assert.equal(options[flag], value, `${flag} must be ${value}`);
    }
  });
}
