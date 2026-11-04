// QB-17 (T-050): builds the app with canary values in every server secret and scans the build output for them.
// A canary must never appear in what the browser can receive: client chunks (static/), prerendered HTML and RSC
// payloads. The build output goes to .next-canary (NEXT_DIST_DIR) so a running `next dev` is left alone.
// Never prints env values; the canaries are synthetic. Used by tests/client-bundle.test.ts.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIST_DIR = ".next-canary";

export const CANARIES = {
  INTUIT_CLIENT_ID: "canary-intuit-client-id-5d1e8a40",
  INTUIT_CLIENT_SECRET: "canary-intuit-client-secret-7b3f92c6",
  INTUIT_WEBHOOK_VERIFIER_TOKEN: "canary-intuit-verifier-token-c40a1e77",
  INTUIT_REDIRECT_URI: "http://localhost:3000/api/connect/qbo/canary-redirect-9a6d",
  SUPABASE_SECRET_KEY: "sb_secret_canaryServerKey0123456789",
};

/** A canary plus the encodings it could leak in. */
export function forms(value) {
  const bytes = Buffer.from(value, "utf8");
  return [...new Set([value, encodeURIComponent(value), bytes.toString("base64"), bytes.toString("base64url"), JSON.stringify(value).slice(1, -1)])];
}

const SKIP_DIRS = new Set(["cache", "trace", "diagnostics"]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && !/^trace(-build)?$/.test(entry.name) && statSync(full).size < 64 * 1024 * 1024) yield full;
  }
}

/** Files under `dir` that contain any canary (in any encoding). Returns [{ file, name }] and the number of files scanned. */
export function scanForCanaries(dir, canaries = CANARIES) {
  const needles = Object.entries(canaries).flatMap(([name, value]) => forms(value).map((form) => ({ name, form })));
  const hits = [];
  let scanned = 0;
  for (const file of walk(dir)) {
    scanned += 1;
    const text = readFileSync(file).toString("latin1");
    const utf8 = readFileSync(file, "utf8");
    for (const { name, form } of needles) if (text.includes(form) || utf8.includes(form)) hits.push({ file: path.relative(dir, file), name });
  }
  return { hits, scanned };
}

/** Production build with the canaries in the environment; returns the dist directory. Throws (no values) on failure. */
export function buildWithCanaries() {
  const polluting = readdirSync(web).filter((f) => /^\.env(\..*)?$/.test(f) && f !== ".env.example");
  if (polluting.length > 0) throw new Error(`client-bundle-check refused: remove ${polluting.join(", ")} first (Next.js would load it).`);
  const dist = path.join(web, DIST_DIR);
  rmSync(dist, { recursive: true, force: true });
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => /^(PATH|HOME|USER|SHELL|LANG|LC_[A-Z]+|TERM|TMPDIR|TEMP|TMP|NODE_[A-Z_]+|npm_[a-z_]+|PNPM_[A-Z_]+|COREPACK_[A-Z_]+|XDG_[A-Z_]+)$/.test(k)),
    ),
    NEXT_DIST_DIR: DIST_DIR,
    APP_ENV: "local",
    ENABLED_LANES: "PKG",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_canaryPublicKey0123456789",
    ...CANARIES,
  };
  // `next build` may rewrite next-env.d.ts; put it back as it was.
  const dts = path.join(web, "next-env.d.ts");
  const backup = `${dts}.canary-backup`;
  if (existsSync(dts)) copyFileSync(dts, backup);
  const result = spawnSync("pnpm", ["exec", "next", "build"], { cwd: web, env, encoding: "utf8", timeout: 8 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  if (existsSync(backup)) {
    copyFileSync(backup, dts);
    unlinkSync(backup);
  }
  if (result.error || result.status !== 0) {
    // Build output can echo configuration; print only its tail, and only if it carries no canary.
    const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`.split("\n").slice(-40).join("\n");
    const safe = Object.values(CANARIES).every((c) => !tail.includes(c));
    throw new Error(`next build failed (status ${result.status ?? "none"})${safe ? `:\n${tail}` : " (output withheld)"}`);
  }
  if (!existsSync(dist)) throw new Error(`build produced no ${DIST_DIR}`);
  return dist;
}
