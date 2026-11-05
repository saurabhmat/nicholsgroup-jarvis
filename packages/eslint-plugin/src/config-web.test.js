// The real apps/web/eslint.config.mjs (Next + typescript-eslint strict + boundary rules), loaded the way `eslint`
// run inside apps/web loads it. Separate file from config-files.test.js: eslint-config-next and the root parser must
// not share a vitest worker (typescript-estree keeps process-wide project state).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const web = new ESLint({ cwd: path.join(ROOT, "apps/web"), overrideConfigFile: path.join(ROOT, "apps/web/eslint.config.mjs") });
/** @param {string} code */
const run = async (code) => {
  const [result] = await web.lintText(code, { filePath: path.join(ROOT, "apps/web/app/x.ts") });
  return (result?.messages ?? []).map((m) => String(m.ruleId));
};

describe("apps/web/eslint.config.mjs", () => {
  // The first lint loads eslint-config-next cold, which can exceed vitest's 5 s default when turbo runs suites in parallel.
  it("enforces the boundary rules", { timeout: 30_000 }, async () => {
    expect(await run(`import Stripe from "stripe";\nexport default Stripe;`)).toContain("nichols/no-vendor-sdk");
  });
  it("blocks inline disables of a boundary rule", async () => {
    const ids = await run(`// eslint-disable-next-line nichols/no-vendor-sdk\nimport Stripe from "stripe";\nexport default Stripe;`);
    expect(ids).toContain("@eslint-community/eslint-comments/no-restricted-disable");
  });
  it("applies typescript-eslint strict", async () => {
    expect(await run(`export const a: any = 1;`)).toContain("@typescript-eslint/no-explicit-any");
    expect(await run(`export const b = (x: number | undefined) => x!;`)).toContain("@typescript-eslint/no-non-null-assertion");
  });
});
