// Shared e2e steps: email-code sign-in and the TOTP step. Tests run in one worker (playwright.config.ts), so the
// authenticator secrets enrolled during a run are remembered here for later sign-ins of the same persona.
import { expect, type Page } from "@playwright/test";
import { latestSignInEmail } from "./mailpit";
import { totp } from "./totp";

const SECRETS = new Map<string, string>();

/** Signs in with the emailed 6-digit code; the browser ends on the /mfa step. */
export async function signInWithEmailCode(page: Page, email: string, path = "/sign-in"): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page).toHaveURL(/\/sign-in\/verify$/);
  const { code } = await latestSignInEmail(email);
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/mfa(\?|$)/);
}

/** Enrols an authenticator on the /mfa page, remembers and returns its secret. */
export async function enrollTotp(page: Page, email: string): Promise<string> {
  await expect(page.getByRole("heading", { name: "Set up two-factor authentication" })).toBeVisible();
  const secret = await page.getByTestId("totp-secret").inputValue();
  await page.getByLabel("Authenticator code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  SECRETS.set(email, secret);
  return secret;
}

/** Completes the /mfa step for `email`: enrols on first use in this run, otherwise enters the current code. */
export async function completeMfa(page: Page, email: string): Promise<string> {
  const heading = page.getByRole("heading", { name: /Set up two-factor authentication|Enter your authenticator code/ });
  await expect(heading).toBeVisible();
  if ((await heading.textContent())?.startsWith("Set up")) return enrollTotp(page, email);
  const secret = SECRETS.get(email);
  if (!secret) throw new Error(`${email} was enrolled outside this run; reset the database (global setup does)`);
  await page.getByLabel("Authenticator code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  return secret;
}

/** Waits until the next 30 s TOTP window, so a new code differs from one already used (replays are refused). */
export async function nextTotpWindow(page: Page): Promise<void> {
  await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
}
