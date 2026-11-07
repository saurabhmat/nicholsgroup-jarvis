// Boundary tests (T-210, spec §3): no connector path writes to brain.*, and nothing outside the brain module and the
// reviewed wiring names the brain schema, so brain rows are written only by the security-definer functions.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..", "..");

const sources = (dir: string): string[] =>
  readdirSync(path.join(repo, dir), { recursive: true })
    .map(String)
    .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/(^|\/)(node_modules|dist)\//.test(f) && !/\.test\./.test(f))
    .map((f) => path.join(repo, dir, f));

const NAMES_BRAIN_DB = /schema\(\s*["']brain["']\s*\)|["'`]brain_(document|documents|employee|employees|skill|skills|import|home)[a-z_]*["'`]|\bbrain\.(documents|document_versions|employees|skills|imports|import_candidates)\b/;

describe("brain schema boundary", () => {
  it("no connector file touches brain.* or the core.brain_* functions", () => {
    const offenders = sources("packages/connectors/src").filter((f) => NAMES_BRAIN_DB.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("the web app does not query brain tables directly", () => {
    const offenders = [...sources("apps/web/app"), ...sources("apps/web/lib")].filter((f) => NAMES_BRAIN_DB.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
