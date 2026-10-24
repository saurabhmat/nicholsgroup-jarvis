import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    alias: {
      "server-only": fileURLToPath(new URL("./test-stubs/server-only.ts", import.meta.url)),
    },
  },
});
