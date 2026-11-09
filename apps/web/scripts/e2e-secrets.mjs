// TOTP secrets enrolled during one e2e run (H-042 fix): a JSON file under the git-ignored test-results/ folder, so a
// Playwright worker restarted after a failure still signs in the personas enrolled before it. Synthetic local personas
// only; the global setup deletes the file whenever it resets the local database (the factors are gone then).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SECRETS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-results/.e2e-totp-secrets.json");

export function readSecrets() {
  try {
    const parsed = JSON.parse(readFileSync(SECRETS_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSecret(email, secret) {
  const all = { ...readSecrets(), [email]: secret };
  mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  const tmp = `${SECRETS_FILE}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
  renameSync(tmp, SECRETS_FILE); // atomic: a killed worker never leaves half a file
}

export function clearSecrets() {
  rmSync(SECRETS_FILE, { force: true });
}
