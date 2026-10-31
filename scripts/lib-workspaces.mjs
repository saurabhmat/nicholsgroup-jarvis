// Shared helpers for the repo-policy tests: workspace discovery and a file walker.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".next", "dist", ".git", ".turbo", ".agent", ".vercel", "coverage"]);

/** Directories (repo-relative) of every pnpm workspace package, from pnpm-workspace.yaml `packages:` globs. */
export function workspaceDirs() {
  const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const patterns = [...yaml.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((m) => m[1]).filter((p) => p.endsWith("/*"));
  const dirs = [];
  for (const pattern of patterns) {
    const parent = pattern.slice(0, -2);
    for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
      const rel = `${parent}/${entry.name}`;
      if (entry.isDirectory() && existsSync(join(ROOT, rel, "package.json"))) dirs.push(rel);
    }
  }
  return dirs.sort();
}

export const readJson = (/** @type {string} */ file) => JSON.parse(readFileSync(file, "utf8"));

/** All files under `dir` (absolute), skipping dependency and build folders. */
export function walk(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}
