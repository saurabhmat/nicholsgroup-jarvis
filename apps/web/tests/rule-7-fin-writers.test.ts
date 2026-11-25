// T-170 (security suite), rule 7 (code side): AI output never writes financial tables. The two database functions that write `fin` tables (found by
// pgTAP 339) are called from connector jobs only: no file outside packages/connectors names them, no file outside the connectors and core reaches a `fin` table
// at all, and none of the files that send content to a model (or handle model output) mention a fin writer or a fin table.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");
const SKIP = new Set(["node_modules", "dist", ".next", ".next-e2e", ".next-canary", ".turbo", ".git", "test-results", "test-stubs", "e2e", "coverage"]);
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (SKIP.has(n) ? [] : statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = [...walk(join(REPO, "apps")), ...walk(join(REPO, "packages"))]
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts") && !f.includes("/testing/"))
  .map((f) => relative(REPO, f));
const read = (f: string) => readFileSync(join(REPO, f), "utf8");
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("rule 7: financial tables are written by connector jobs only", () => {
  it("the fin writer functions are named only inside packages/connectors (and the generated database types)", () => {
    const hits = files.filter((f) => /fin_report_cache_put|fin_qbo_normalize/.test(code(read(f)))).filter((f) => !f.startsWith("packages/connectors/src/") && !/database\.types|db-types|types\/database|packages\/core\/src\/db\/types\.ts/.test(f));
    expect(hits).toEqual([]);
  });
  it("no file outside packages/connectors, packages/core and the finance reads reaches a fin table or the fin schema by name", () => {
    const hits = files.filter((f) => /schema\(\s*["']fin["']\s*\)|from\(\s*["']fin\.|\bfin\.(transactions|invoices|bills|payments|accounts|report_cache|normalize_runs)\b/.test(code(read(f))));
    const allowed = (f: string) => f.startsWith("packages/connectors/src/") || f.startsWith("packages/core/src/") || /database\.types|types\/database|packages\/core\/src\/db\/types\.ts/.test(f);
    expect(hits.filter((f) => !allowed(f))).toEqual([]);
  });
  it("the files that send content to a model or handle model output never mention a fin writer or the fin schema", () => {
    const modelFiles = files.filter((f) => /from "@nichols\/ai(\/[a-z]+)?"/.test(read(f)) || f.startsWith("packages/ai/src/"));
    expect(modelFiles.length).toBeGreaterThan(10);
    for (const f of modelFiles) expect(/fin_report_cache_put|fin_qbo_normalize|schema\(\s*["']fin["']\s*\)|from\(\s*["']fin\./.test(code(read(f))), f).toBe(false);
  });
});
