// Rule 5 boundary for the Microsoft write path (T-262): no production file outside the connector's own wiring and packages/modules/approvals may name the Microsoft
// email writer or the Graph write client, import the write subpath, or build a Graph write route. A test file is not production. The first assertion is the proof that
// the scan itself works (it must find the files that are allowed to).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
function production(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".next", "dist", ".turbo", ".git", "test-stubs"].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec)\./.test(name)) files.push(p);
    }
  };
  walk(join(root, "apps"));
  walk(join(root, "packages"));
  return files;
}
const rel = (f: string) => relative(root, f);

describe("the Microsoft write path is reachable only from approvals", () => {
  it("only the writer, its wiring, the write subpath and packages/modules/approvals name the writer or the write client", () => {
    const offenders = production()
      .filter((f) => /microsoftEmailWriter|microsoftEmailReconciler|createMicrosoftEmailWriter|createGraphWriteClient|GraphWriteClient|microsoft\/email-writer|microsoft\/write-client/.test(readFileSync(f, "utf8")))
      .map(rel)
      .filter((f) => !f.startsWith("packages/modules/approvals/") && !f.startsWith("packages/eslint-plugin/src/"))
      .sort();
    expect(offenders).toEqual([
      "packages/connectors/src/microsoft/email-writer.ts",
      "packages/connectors/src/microsoft/index.ts",
      "packages/connectors/src/microsoft/write-client.ts",
      "packages/connectors/src/write/index.ts",
    ]);
  });

  it("no production file other than the write client builds a POST or PATCH request to Graph, and only approvals imports the write subpath", () => {
    const files = production();
    const posters = files
      .filter((f) => rel(f).startsWith("packages/connectors/src/microsoft/") && /method:\s*"(POST|PATCH|PUT|DELETE)"/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    // the token manager POSTs to the sign-in host (token endpoint), not to Graph; the write client and the writer are the Graph writers
    expect(posters).toEqual(["packages/connectors/src/microsoft/email-writer.ts", "packages/connectors/src/microsoft/token-manager.ts", "packages/connectors/src/microsoft/write-client.ts"]);
    const importers = files
      .filter((f) => /from\s+["']@nichols\/connectors\/write["']/.test(readFileSync(f, "utf8")))
      .map(rel)
      .filter((f) => !f.startsWith("packages/modules/approvals/"));
    expect(importers).toEqual([]);
  });
});
