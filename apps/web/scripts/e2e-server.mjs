#!/usr/bin/env node
// Starts the app for the Playwright tests against the LOCAL Supabase stack (T-018). The local URL and keys come
// from `supabase status -o env` and go straight into the child's environment: never printed, never written to a file.
// Refuses to run when apps/web has .env files (they would override these values).
// E2E_SERVER=dev (default): `next dev`. E2E_SERVER=build: `next build` then `next start` (H-042: much faster page loads
// on a slow filesystem; the build takes a few minutes first). The build goes to its own folder, `.next-e2e`, never
// `.next`: a normal build made with apps/web/.env.local has the REAL Supabase URL and key inlined, and must never be
// served to the e2e personas. E2E_SKIP_BUILD=1 reuses the last e2e build only when its marker names the same local
// Supabase URL as now; otherwise it refuses.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

const mode = process.env.E2E_SERVER ?? "dev";
if (mode !== "dev" && mode !== "build") {
  console.error('e2e-server: E2E_SERVER must be "dev" or "build".');
  process.exit(1);
}

// Only what Next needs from the shell: no credentials from the developer's environment reach the app.
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /^(PATH|HOME|USER|SHELL|LANG|LC_[A-Z]+|TERM|TMPDIR|TEMP|TMP|NODE_[A-Z_]+|npm_[a-z_]+|PNPM_[A-Z_]+|COREPACK_[A-Z_]+|XDG_[A-Z_]+)$/.test(k)),
  ),
  APP_ENV: "local",
  ...(process.env.SERVER_TIMING === "1" ? { SERVER_TIMING: "1" } : {}), // T-230 A: server timing for the measurement spec only
  ENABLED_LANES: "PKG",
  NEXT_PUBLIC_APP_URL: `http://localhost:${E2E_PORT}`,
  NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY: local.SECRET_KEY,
};
delete env.NODE_ENV; // next dev / build / start each set it; a value from the shell would conflict

const E2E_DIST = ".next-e2e"; // allow-listed in next.config.ts
const marker = path.join(web, E2E_DIST, "e2e-local-api-url");
if (mode === "build") env.NEXT_DIST_DIR = E2E_DIST; // both build and start read it

if (mode === "build" && process.env.E2E_SKIP_BUILD !== "1") {
  console.error("e2e-server: next build (E2E_SERVER=build) ...");
  // The same scrubbed env (APP_ENV=local, local Supabase only): the NEXT_PUBLIC_ values are inlined into this build.
  const build = spawnSync("pnpm", ["exec", "next", "build"], { cwd: web, stdio: ["ignore", "inherit", "inherit"], env });
  if (build.status !== 0) {
    console.error("e2e-server: next build failed.");
    process.exit(build.status ?? 1);
  }
  // Records which local Supabase this build inlined, for E2E_SKIP_BUILD (a local URL: not a secret).
  writeFileSync(marker, local.API_URL);
} else if (mode === "build") {
  const built = existsSync(marker) ? readFileSync(marker, "utf8") : null;
  if (built !== local.API_URL) {
    console.error("e2e-server: E2E_SKIP_BUILD=1 refused: no e2e build for this local Supabase stack. Run once without it.");
    process.exit(1);
  }
}
const args = mode === "build" ? ["exec", "next", "start"] : ["exec", "next", "dev"];
const child = spawn("pnpm", [...args, "--hostname", "127.0.0.1", "--port", String(E2E_PORT)], {
  cwd: web,
  stdio: ["ignore", "inherit", "inherit"],
  env,
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
