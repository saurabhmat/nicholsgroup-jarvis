#!/usr/bin/env node
// Microsoft 365 connect and sync on the LOCAL stack (H-070 step 1, the local live check). Run by a person, not by
// agents. Starts `next dev` on port 3000 (the redirect URI registered in the Entra app) against the LOCAL Supabase stack.
// Modelled on qbo-sandbox-dev.mjs.
//
// Unlike the QuickBooks launcher there is no sandbox switch: Microsoft has none. This run signs in to a REAL Microsoft 365
// tenant (the one in the local lane_config) and stores that mailbox's mail and calendar metadata and a refresh token in
// the LOCAL database. Which tenant and mailbox may be used is decision D-56 in docs/backlog.md.
//
// Secrets: only the three GRAPH_* names are taken from the repo-root `.env.local` (or the file given with --env). With
// --with-ai the three ANTHROPIC_* names are taken too (the briefing and the assistant need them; without the flag the
// app runs without AI). The values go straight into the child's environment and are never printed or written anywhere.
// Anything else in that file is ignored. The script refuses to start unless the redirect URI is the localhost one and
// the database is the local one.
//
// Background jobs (the mail and calendar sync) need the Inngest dev server in a second terminal:
//   npx inngest-cli@latest dev -u http://127.0.0.1:3000/api/inngest
//
// Usage (from the repo root):  node apps/web/scripts/microsoft-local-dev.mjs [--with-ai] [--env <file>]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(web, "../..");
const workdir = path.join(root, "supabase/core");
const PORT = 3000;
const args = process.argv.slice(2);
const withAi = args.includes("--with-ai");
const envFile = args.includes("--env") ? path.resolve(args[args.indexOf("--env") + 1] ?? "") : path.join(root, ".env.local");
const fail = (msg) => {
  console.error(`microsoft-local-dev: ${msg}`);
  process.exit(1);
};

if (readdirSync(web).some((f) => f.startsWith(".env"))) fail("remove apps/web/.env* first (they would override these values).");
if (!existsSync(envFile)) fail(`no ${path.relative(root, envFile) || envFile}; it must hold the Microsoft app values.`);

// Only these names are read from the file. Values are never echoed.
const GRAPH = ["GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "GRAPH_REDIRECT_URI"];
const AI = ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL_ANALYSIS", "ANTHROPIC_MODEL_FAST"];
const WANTED = withAi ? [...GRAPH, ...AI] : GRAPH;
const picked = {};
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (!m || !WANTED.includes(m[1])) continue;
  picked[m[1]] = m[2].replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
}
for (const name of WANTED) if (!picked[name]) fail(`${name} is missing from ${path.basename(envFile)}.`);
if (picked.GRAPH_REDIRECT_URI !== `http://localhost:${PORT}/api/connect/microsoft/callback`) {
  fail(`GRAPH_REDIRECT_URI must be http://localhost:${PORT}/api/connect/microsoft/callback (as registered in the Entra app).`);
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

console.log(`microsoft-local-dev: open http://localhost:${PORT} (use localhost, not 127.0.0.1). Sign-in codes: http://localhost:54324`);
console.log(`microsoft-local-dev: AI is ${withAi ? "ON (--with-ai)" : "OFF (add --with-ai for the briefing and the assistant)"}. Jobs need the Inngest dev server (see the header of this file).`);
const child = spawn("pnpm", ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(PORT)], {
  cwd: web,
  stdio: ["ignore", "inherit", "inherit"],
  // Only what next dev needs from the shell, plus the local stack and the Microsoft (and, with --with-ai, Anthropic) values.
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
    ...picked,
  },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 1));
