#!/usr/bin/env node
// QuickBooks SANDBOX run on the local stack (T-050 / T-197 manual checks, QB-1 – QB-20). Run by a person, not by
// agents. Starts `next dev` on port 3000 (the redirect URI registered with Intuit) against the LOCAL Supabase stack.
//
// Secrets: only the four INTUIT_* names are taken from the repo-root `.env.local` (or the file given with --env). They
// go straight into the child's environment and are never printed or written anywhere. Anything else in that file is
// ignored. The script refuses to start unless INTUIT_ENVIRONMENT=sandbox and the redirect URI is localhost:3000.
//
// Usage (from the repo root):  node apps/web/scripts/qbo-sandbox-dev.mjs [--env <file>]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(web, "../..");
const workdir = path.join(root, "supabase/core");
const PORT = 3000;
const args = process.argv.slice(2);
const envFile = args.includes("--env") ? path.resolve(args[args.indexOf("--env") + 1] ?? "") : path.join(root, ".env.local");
const fail = (msg) => {
  console.error(`qbo-sandbox-dev: ${msg}`);
  process.exit(1);
};

if (readdirSync(web).some((f) => f.startsWith(".env"))) fail("remove apps/web/.env* first (they would override these values).");
if (!existsSync(envFile)) fail(`no ${path.relative(root, envFile) || envFile}; it must hold the Intuit sandbox keys.`);

// Only these names are read from the file. Values are never echoed.
const WANTED = ["INTUIT_CLIENT_ID", "INTUIT_CLIENT_SECRET", "INTUIT_ENVIRONMENT", "INTUIT_REDIRECT_URI"];
const intuit = {};
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (!m || !WANTED.includes(m[1])) continue;
  intuit[m[1]] = m[2].replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
}
for (const name of WANTED) if (!intuit[name]) fail(`${name} is missing from ${path.basename(envFile)}.`);
if (intuit.INTUIT_ENVIRONMENT !== "sandbox") fail("INTUIT_ENVIRONMENT must be sandbox for this run (never production keys).");
if (intuit.INTUIT_REDIRECT_URI !== `http://localhost:${PORT}/api/connect/qbo/callback`) {
  fail(`INTUIT_REDIRECT_URI must be http://localhost:${PORT}/api/connect/qbo/callback (as registered with Intuit).`);
}

const status = spawnSync("supabase", ["status", "-o", "env", "--workdir", workdir], { encoding: "utf8" });
if (status.status !== 0) fail("local Supabase is not running. Start it with `pnpm db:start`.");
const local = Object.fromEntries(
  status.stdout
    .split("\n")
    .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
for (const name of ["API_URL", "PUBLISHABLE_KEY", "SECRET_KEY", "DB_URL"]) if (!local[name]) fail(`${name} missing from \`supabase status\`.`);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(local.API_URL)) fail("refusing a non-local Supabase URL.");
if (!/@(127\.0\.0\.1|localhost):/.test(local.DB_URL)) fail("refusing a non-local database URL.");

console.log(`qbo-sandbox-dev: open http://localhost:${PORT} (use localhost, not 127.0.0.1). Sign-in codes: http://localhost:54324`);
const child = spawn("pnpm", ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(PORT)], {
  cwd: web,
  stdio: ["ignore", "inherit", "inherit"],
  // Only what next dev needs from the shell, plus the local stack and the four Intuit sandbox values.
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => /^(PATH|HOME|USER|SHELL|LANG|LC_[A-Z]+|TERM|TMPDIR|TEMP|TMP|NODE_[A-Z_]+|npm_[a-z_]+|PNPM_[A-Z_]+|COREPACK_[A-Z_]+|XDG_[A-Z_]+)$/.test(k)),
    ),
    APP_ENV: "local",
    ENABLED_LANES: "PKG",
    NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
    NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: local.SECRET_KEY,
    ...intuit,
  },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
