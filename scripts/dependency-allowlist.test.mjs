// Policy test: every workspace package may declare only the dependencies on its explicit allow-list, and vendor /
// network / DB SDKs may be declared only where the boundary rules allow importing them (security review H3).
// Adding a dependency means editing ALLOWED below, in the same PR, where a reviewer sees it.
// The lint rule `nichols/no-vendor-sdk` is the second layer: it stops the import even if a dependency sneaks in
// through a transitive install.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { VENDORS } from "@nichols/eslint-plugin";
import { ROOT, readJson, workspaceDirs } from "./lib-workspaces.mjs";

const CORE_ONLY = ["@nichols/core"];
/** package dir (repo-relative, "." = root) -> allowed dependency names (any of dependencies/devDependencies/peer/optional) */
const ALLOWED = {
  ".": ["@nichols/core", "@nichols/eslint-plugin", "@types/node", "eslint", "turbo", "typescript", "typescript-eslint", "vitest"],
  "apps/web": [
    "@nichols/core",
    "@nichols/eslint-plugin",
    "@nichols/ui", // T-022
    "@tailwindcss/turbopack",
    "@types/node",
    "@types/react",
    "@types/react-dom",
    "eslint",
    "eslint-config-next",
    "next",
    "react",
    "react-dom",
    "tailwindcss",
    "typescript",
    "typescript-eslint",
  ],
  "packages/ai": CORE_ONLY, // @anthropic-ai/sdk joins this list with T-100
  // vendor SDKs join this list with their connectors (T-04x...); zod for the contract schemas, vitest for the kit (T-030)
  "packages/connectors": [...CORE_ONLY, "vitest", "zod"],
  "packages/core": ["server-only", "zod"],
  "packages/eslint-plugin": ["@eslint-community/eslint-plugin-eslint-comments", "@nichols/core", "eslint", "typescript-eslint"],
  // T-022: shadcn/ui primitives and their test setup
  "packages/ui": [
    "@testing-library/dom",
    "@testing-library/react",
    "@types/react",
    "@types/react-dom",
    "class-variance-authority",
    "clsx",
    "jsdom",
    "react",
    "react-dom",
    "tailwind-merge",
  ],
  ...Object.fromEntries(
    ["admin", "approvals", "briefing", "calendar", "commitments", "comms", "documents", "finance", "memory", "notifications", "projects"].map((m) => [
      `packages/modules/${m}`,
      CORE_ONLY,
    ]),
  ),
};

/** same matching as the lint rule: "name", "name/sub", or "@scope/*" */
const matches = (/** @type {string} */ dep, /** @type {string} */ pattern) =>
  pattern.endsWith("/*") ? dep.startsWith(pattern.slice(0, -1)) : dep === pattern || dep.startsWith(`${pattern}/`);
const isUnder = (/** @type {string} */ dir, /** @type {string[]} */ prefixes) => prefixes.some((p) => dir === p || dir.startsWith(`${p}/`));

const declared = (/** @type {string} */ dir) => {
  const pkg = readJson(join(ROOT, dir, "package.json"));
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
};
const DIRS = [".", ...workspaceDirs()];

test("every workspace package has an allow-list entry (and no stale entries)", () => {
  assert.deepEqual(Object.keys(ALLOWED).sort(), [...DIRS].sort());
});

for (const dir of DIRS) {
  test(`${dir}: declares only allow-listed dependencies`, () => {
    const extra = declared(dir).filter((dep) => !(ALLOWED[dir] ?? []).includes(dep));
    assert.deepEqual(extra, [], `add to ALLOWED in scripts/dependency-allowlist.test.mjs only after review`);
  });

  test(`${dir}: declares no vendor, network or DB SDK outside its permitted packages`, () => {
    const bad = [];
    for (const dep of declared(dir)) {
      for (const [pattern, allowedPrefixes] of Object.entries(VENDORS)) {
        if (matches(dep, pattern) && !isUnder(dir, allowedPrefixes)) bad.push(`${dep} (allowed only in ${allowedPrefixes.join(", ")})`);
      }
    }
    assert.deepEqual(bad, []);
  });
}

test("the allow-lists themselves never grant a vendor SDK outside its permitted packages", () => {
  const bad = [];
  for (const [dir, deps] of Object.entries(ALLOWED)) {
    for (const dep of deps) {
      for (const [pattern, allowedPrefixes] of Object.entries(VENDORS)) {
        if (matches(dep, pattern) && !isUnder(dir, allowedPrefixes)) bad.push(`${dir}: ${dep}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("@anthropic-ai/sdk is permitted only in packages/ai and nothing else network-capable is in connectors' lint exemptions", () => {
  assert.deepEqual(VENDORS["@anthropic-ai/*"], ["packages/ai"]);
  assert.ok(VENDORS["stripe"]?.includes("packages/connectors"));
  assert.ok(!VENDORS["stripe"]?.includes("packages/ai"));
});
