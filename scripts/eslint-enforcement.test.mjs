// Policy test: lint enforcement cannot be bypassed by configuration (security review H2).
//  1. the only ESLint config files are the root one and apps/web's;
//  2. every workspace package runs the expected lint command;
//  3. the resolved config for a source file of every workspace package (and for supabase/functions) has every
//     nichols/* rule and the disable-directive guards at severity 2.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { plugin } from "@nichols/eslint-plugin";
import { ESLint } from "eslint";
import { ROOT, readJson, walk, workspaceDirs } from "./lib-workspaces.mjs";

const EXPECTED_RULES = [
  ...Object.keys(plugin.rules).map((r) => `nichols/${r}`),
  "@eslint-community/eslint-comments/no-restricted-disable",
  "@eslint-community/eslint-comments/no-unlimited-disable",
];
const WEB_LINT = "eslint";
const PACKAGE_LINT = "eslint .";

test("the only ESLint config files are the root one and apps/web's", () => {
  const found = walk()
    .map((f) => f.slice(ROOT.length + 1))
    .filter((f) => /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\..+)?|\.eslintignore)$/.test(f))
    .sort();
  assert.deepEqual(found, ["apps/web/eslint.config.mjs", "eslint.config.mjs"]);
});

test("no package.json carries an inline eslintConfig", () => {
  for (const file of ["package.json", ...workspaceDirs().map((d) => `${d}/package.json`)]) {
    assert.equal(readJson(join(ROOT, file)).eslintConfig, undefined, `${file} has eslintConfig`);
  }
});

test("workspace discovery finds the expected packages", () => {
  const dirs = workspaceDirs();
  for (const d of ["apps/web", "packages/core", "packages/connectors", "packages/ai", "packages/ui", "packages/eslint-plugin", "packages/modules/approvals"]) {
    assert.ok(dirs.includes(d), `missing ${d}`);
  }
});

for (const dir of workspaceDirs()) {
  const expectedLint = dir === "apps/web" ? WEB_LINT : PACKAGE_LINT;
  test(`${dir}: lint script is "${expectedLint}"`, () => {
    assert.equal(readJson(join(ROOT, dir, "package.json")).scripts?.lint, expectedLint);
  });

  test(`${dir}: resolved config enforces every nichols rule at error`, async () => {
    const sample = ["app/page.tsx", "src/index.ts", "src/index.js"].find((f) => existsSync(join(ROOT, dir, f)));
    assert.ok(sample, `${dir} has no sample source file (app/page.tsx, src/index.ts or src/index.js)`);
    const eslint = new ESLint({ cwd: join(ROOT, dir) });
    const config = await eslint.calculateConfigForFile(join(ROOT, dir, sample));
    assert.ok(config, `${dir}: sample file is ignored by ESLint`);
    for (const id of EXPECTED_RULES) {
      const entry = config.rules?.[id];
      assert.ok(entry, `${dir}: ${id} is not configured`);
      assert.equal(entry[0], 2, `${dir}: ${id} is not at severity error`);
    }
    assert.equal(config.linterOptions?.reportUnusedDisableDirectives, 2);
  });
}

test("supabase/functions (future Edge Functions) is covered by the root config", async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const config = await eslint.calculateConfigForFile(join(ROOT, "supabase/functions/example/index.ts"));
  assert.ok(config, "supabase/functions is ignored by ESLint");
  for (const id of EXPECTED_RULES) assert.equal(config.rules?.[id]?.[0], 2, id);
});

test("the root lint script lints scripts, supabase/functions and the root config", () => {
  const lint = readJson(join(ROOT, "package.json")).scripts.lint;
  assert.match(lint, /turbo run lint/);
  for (const target of ["scripts", "supabase/functions", "eslint.config.mjs"]) assert.ok(lint.includes(target), `lint must cover ${target}`);
});

test("turbo does not cache lint", () => {
  const turbo = JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8"));
  assert.equal(turbo.tasks.lint.cache, false);
});
