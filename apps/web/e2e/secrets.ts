// TOTP secrets enrolled during one e2e run (H-042 fix): a JSON file in Playwright's output folder (git-ignored
// test-results/), so a worker restarted after a failure still signs in the personas enrolled before it. Synthetic local
// personas only; the global setup (scripts/e2e-reset.mjs) deletes it whenever it resets the local database.
// The folder is passed in (test.info().project.outputDir in tests, config.projects[0].outputDir in global setup), not
// derived from this module's location: Playwright loads this file as CommonJS from the specs and as ESM from the
// global setup, and neither `import.meta` nor `__dirname` works in both.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const secretsFile = (outputDir: string): string => path.join(outputDir, ".e2e-totp-secrets.json");

export function readSecrets(outputDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(secretsFile(outputDir), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

export function writeSecret(outputDir: string, email: string, secret: string): void {
  const file = secretsFile(outputDir);
  const all = { ...readSecrets(outputDir), [email]: secret };
  mkdirSync(outputDir, { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
  renameSync(tmp, file); // atomic: a killed worker never leaves half a file
}

export function clearSecrets(outputDir: string): void {
  rmSync(secretsFile(outputDir), { force: true });
}
