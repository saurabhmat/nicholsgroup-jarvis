import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for the app's server-side helpers (lane loading, return paths, the proxy). The browser suite is Playwright
// (e2e/), which Vitest must not pick up.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(new URL("../../packages/core/test-stubs/server-only.ts", import.meta.url)),
    },
  },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    // Component tests (.tsx) opt into jsdom with a `// @vitest-environment jsdom` comment.
    include: ["tests/**/*.test.ts", "lib/**/*.test.ts", "components/**/*.test.tsx"],
    // The real `next build` canary scan is `pnpm test:bundle` (vitest.bundle.config.ts).
    exclude: ["tests/bundle/**", "node_modules/**"],
  },
});
