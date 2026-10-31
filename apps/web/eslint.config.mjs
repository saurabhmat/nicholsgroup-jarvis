import { nicholsConfig } from "@nichols/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

// typescript-eslint "strict" rules, applied through the plugin instance eslint-config-next already registered
// (registering a second copy of the plugin under the same name is an error).
const strictRules = Object.assign({}, ...tseslint.configs.strict.map((config) => config.rules ?? {}));

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  { name: "nichols/typescript-strict", files: ["**/*.{ts,tsx,mts,cts}"], rules: strictRules },
  // Architectural boundary rules shared with the root config (packages/eslint-plugin).
  ...nicholsConfig({ root: new URL("../../", import.meta.url) }),
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
