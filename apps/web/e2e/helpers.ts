// Shared e2e steps: email-code sign-in and the TOTP step.
import { expect, type Page } from "@playwright/test";
import { latestSignInEmail } from "./mailpit";
import { totp } from "./totp";

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

/** Enrols an authenticator on the /mfa page and returns its secret (the page shows it for manual entry). */
export async function enrollTotp(page: Page): Promise<string> {
  await expect(page.getByRole("heading", { name: "Set up two-factor authentication" })).toBeVisible();
  const secret = await page.getByTestId("totp-secret").inputValue();
  await page.getByLabel("Authenticator code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  return secret;
}
