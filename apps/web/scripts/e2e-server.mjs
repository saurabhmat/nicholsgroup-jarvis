#!/usr/bin/env node
// Starts `next dev` for the Playwright tests against the LOCAL Supabase stack (T-018). The local URL and keys come
// from `supabase status -o env` and go straight into the child's environment: never printed, never written to a file.
// Refuses to run when apps/web has .env files (they would override these values).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workdir = path.resolve(web, "../../supabase/core");
export const E2E_PORT = 3100;

if (readdirSync(web).some((f) => f.startsWith(".env") && existsSync(path.join(web, f)))) {
  console.error("e2e-server: remove apps/web/.env* first (the tests must run against the local stack only).");
  process.exit(1);
}

const status = spawnSync("supabase", ["status", "-o", "env", "--workdir", workdir], { encoding: "utf8" });
if (status.status !== 0) {
  console.error("e2e-server: local Supabase is not running. Start it with `pnpm db:start`.");
  process.exit(1);
}
const local = Object.fromEntries(
  status.stdout
    .split("\n")
    .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
for (const name of ["API_URL", "PUBLISHABLE_KEY", "SECRET_KEY"]) {
  if (!local[name]) {
    console.error(`e2e-server: ${name} missing from \`supabase status\`.`);
    process.exit(1);
  }
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(local.API_URL)) {
  console.error("e2e-server: refusing a non-local Supabase URL.");
  process.exit(1);
}

const child = spawn("pnpm", ["exec", "next", "dev", "--port", String(E2E_PORT)], {
  cwd: web,
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    APP_ENV: "local",
    ENABLED_LANES: "PKG",
    NEXT_PUBLIC_APP_URL: `http://localhost:${E2E_PORT}`,
    NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: local.SECRET_KEY,
  },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
