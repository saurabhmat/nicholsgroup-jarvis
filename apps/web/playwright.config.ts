// End-to-end tests (T-018 onwards) against `next dev` on the LOCAL Supabase stack (scripts/e2e-server.mjs).
// Run: `pnpm --filter @nichols/web test:e2e` (needs `pnpm db:start`; the seed personas must exist: `pnpm db:reset`).
import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // the tests share one mailbox (local Mailpit)
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${String(PORT)}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "iphone", use: { ...devices["iPhone 15"], browserName: "chromium" } },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: `http://localhost:${String(PORT)}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
