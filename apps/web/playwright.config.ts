// End-to-end tests (T-018 onwards) on the LOCAL Supabase stack (scripts/e2e-server.mjs).
// Run: `pnpm --filter @nichols/web test:e2e` (needs `pnpm db:start`). Global setup resets the local database first.
// E2E_SERVER=build runs against `next build` + `next start` instead of `next dev` (H-042: a slow filesystem makes
// next dev compile each route for tens of seconds on first visit). `pnpm e2e:brain` at the repo root uses it.
import { defineConfig, devices } from "@playwright/test";
import { e2eBuildMode as BUILD, e2eSkipBuild } from "./scripts/e2e-mode.mjs";

const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./scripts/e2e-reset.mjs",
  fullyParallel: false, // the tests share one mailbox (local Mailpit)
  workers: 1,
  retries: 0,
  // Specs that sign in set their own (90 s to 240 s, sized for next dev). The default covers the rest: generous under
  // next dev on a slow filesystem, tighter against a production build where nothing compiles on demand.
  timeout: BUILD ? 90_000 : 180_000,
  expect: { timeout: BUILD ? 10_000 : 20_000 },
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${String(PORT)}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // MFA enrolment is per persona, so each project signs in as different personas (e2e/personas.ts).
    { name: "iphone", use: { ...devices["iPhone 15"], browserName: "chromium" } },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: `http://127.0.0.1:${String(PORT)}/sign-in`,
    reuseExistingServer: false,
    // Build mode includes `next build` before the server answers (several minutes on a slow filesystem).
    timeout: BUILD && !e2eSkipBuild ? 1_200_000 : 300_000,
    // Show the build/server output so a slow or failed start is visible (the values themselves are never printed).
    stdout: "pipe",
    stderr: "pipe",
  },
});
