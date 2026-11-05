// Smoke test: a production-flavoured build with no core env must FAIL and name the missing variables.
// Usage: pnpm --filter @nichols/web check:env-build
// Runs a real `next build` with a scrubbed environment; never prints env values; restores next-env.d.ts.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";

// Next loads .env files itself, so a local or production env file would pollute the check.
const polluting = readdirSync(".").filter((f) => /^\.env(\..*)?$/.test(f) && f !== ".env.example");
if (polluting.length > 0) {
  console.error(
    `check:env-build refused: remove or rename ${polluting.join(", ")} (Next.js would load it and hide missing variables).`,
  );
  process.exit(1);
}

const dts = "next-env.d.ts";
const backup = `${dts}.check-env-backup`;
if (existsSync(dts)) copyFileSync(dts, backup);
const restore = () => {
  if (existsSync(backup)) {
    copyFileSync(backup, dts);
    unlinkSync(backup);
  }
};
process.on("exit", restore);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(NEXT_PUBLIC_|SUPABASE_|INNGEST_|ANTHROPIC_|APP_ENV$|ENABLED_LANES$|VERCEL|NICHOLS_)/.test(key),
  ),
);
env.VERCEL = "1";
env.VERCEL_ENV = "production";

const result = spawnSync("pnpm", ["exec", "next", "build"], { env, encoding: "utf8", timeout: 10 * 60 * 1000 });
restore();

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const expected = ["NEXT_PUBLIC_APP_URL", "SUPABASE_SECRET_KEY", "ANTHROPIC_API_KEY", "INNGEST_SIGNING_KEY"];
const named = expected.filter((name) => output.includes(name));
if (result.error || result.status === 0 || named.length !== expected.length || !output.includes("Values are never printed")) {
  console.error("check:env-build FAILED: the production build did not fail with the expected variable names.");
  process.exit(1);
}
console.log("check:env-build OK: production build failed closed, naming the missing variables.");
