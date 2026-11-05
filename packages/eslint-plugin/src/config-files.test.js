// The real root eslint.config.mjs, loaded the way `eslint` loads it. apps/web's config is tested in
// config-web.test.js (separate file: eslint-config-next and the root parser must not share a vitest worker).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("real root config file", () => {
  const rootEslint = new ESLint({ cwd: ROOT });
  /** @param {ESLint} linter @param {string} code @param {string} file */
  const run = async (linter, code, file) => {
    const [result] = await linter.lintText(code, { filePath: path.join(ROOT, file) });
    return (result?.messages ?? []).map((m) => String(m.ruleId));
  };

  it("the root config enforces the boundary rules for packages and future Edge Functions", async () => {
    expect(await run(rootEslint, `import Stripe from "stripe";\nexport default Stripe;`, "packages/modules/finance/src/x.ts")).toContain("nichols/no-vendor-sdk");
    expect(await run(rootEslint, `export const k = process.env.X;`, "supabase/functions/hook/index.ts")).toContain("nichols/no-process-env");
  }, 30_000); // the first lint loads the whole root config and parser: over 5 s when turbo runs every package at once
  it("the root config does not lint apps/web (its own config does)", async () => {
    expect(await rootEslint.isPathIgnored(path.join(ROOT, "apps/web/app/x.ts"))).toBe(true);
  });
});
