import { defineConfig } from "vitest/config";

// The real `next build` canary scan (T-050, QB-17). Run by `pnpm test:bundle`; excluded from the default config.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/bundle/**/*.test.ts"],
    testTimeout: 10 * 60 * 1000,
  },
});
