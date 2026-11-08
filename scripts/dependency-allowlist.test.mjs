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
    "@nichols/brain", // T-210: the Inngest route wires the import-candidate purge job (@nichols/brain/jobs)
    "@nichols/connectors", // T-035: the /api/connect routes wrap @nichols/connectors/oauth (no vendor SDKs come with it)
    "@nichols/core",
    "@nichols/eslint-plugin",
    "@nichols/ui", // T-022
    "@playwright/test", // T-018 end-to-end tests
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
    "vitest", // T-024: unit tests for lane loading, return paths and the proxy (same version as the workspace)
  ],
  "packages/ai": [...CORE_ONLY, "@anthropic-ai/sdk", "server-only", "zod"], // T-100; server-only: keeps the SDK out of client bundles; zod: strict tool argument schemas (T-101)
  // vendor SDKs join this list with their connectors (T-04x...); zod for the contract schemas, vitest for the kit (T-030)
  "packages/connectors": [...CORE_ONLY, "msw", "vitest", "zod"], // msw: provider mocks for tests (T-034)
  // T-016/T-017: Supabase clients, only importable from the lane router and packages/core/src/auth (lint)
  "packages/core": ["@supabase/ssr", "@supabase/supabase-js", "inngest", "server-only", "zod"], // inngest: T-037
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
    ["admin", "approvals", "brain", "briefing", "calendar", "commitments", "comms", "documents", "finance", "memory", "notifications", "projects"].map((m) => [
      `packages/modules/${m}`,
      CORE_ONLY,
    ]),
  ),
  // T-211: the employee config schema (strict Zod, spec §3). zod has no network or DB access; same major as core.
  "packages/modules/brain": [...CORE_ONLY, "zod"],
};

/** same matching as the lint rule: "name", "name/sub", or "@scope/*" */
const matches = (/** @type {string} */ dep, /** @type {string} */ pattern) =>
  pattern.endsWith("/*") ? dep.startsWith(pattern.slice(0, -1)) : dep === pattern || dep.startsWith(`${pattern}/`);
const isUnder = (/** @type {string} */ dir, /** @type {string[]} */ prefixes) => prefixes.some((p) => dir === p || dir.startsWith(`${p}/`));
/**
 * A package may DECLARE a vendor SDK when it is under a permitted path or contains one (e.g. packages/core contains
 * the lane router); the lint rule then restricts the IMPORT to the permitted path inside it.
 */
const mayDeclare = (/** @type {string} */ dir, /** @type {string[]} */ prefixes) =>
  isUnder(dir, prefixes) || (dir !== "." && prefixes.some((p) => p.startsWith(`${dir}/`)));

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
        if (matches(dep, pattern) && !mayDeclare(dir, allowedPrefixes)) bad.push(`${dep} (allowed only in ${allowedPrefixes.join(", ")})`);
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
        if (matches(dep, pattern) && !mayDeclare(dir, allowedPrefixes)) bad.push(`${dir}: ${dep}`);
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
