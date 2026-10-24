// Minimal shared config for packages/*. T-003 replaces this with the strict shared config and boundary rules.
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["**/dist/**", "**/.next/**", "**/node_modules/**", "apps/**", "scripts/**"]),
  ...tseslint.configs.recommended,
]);
