// Shared e2e steps: email-code sign-in and the TOTP step. Tests run in one worker (playwright.config.ts), so the
// authenticator secrets enrolled during a run are remembered here for later sign-ins of the same persona.
import { expect, type Page } from "@playwright/test";
import { latestSignInEmail } from "./mailpit";
import { totp } from "./totp";

const SECRETS = new Map<string, string>();

/** The authenticator secret enrolled for `email` earlier in this run, if any (used by the HTTP-level specs). */
export const knownAuthenticator = (email: string): string | undefined => SECRETS.get(email);
export const rememberAuthenticator = (email: string, key: string): void => void SECRETS.set(email, key);

/** After sign-in the browser lands on the lane home (T-023): its heading is the "signed in" signal on every viewport. */
export async function expectLaneHome(page: Page, lane = "PKG"): Promise<void> {
  // Generous timeout: next dev compiles the lane routes on first visit, which can exceed the default 5 s.
  await expect(page).toHaveURL(new RegExp(`/${lane}$`), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
}

/** Signs out through the UI: the side menu on desktop; the More tab on iPhone (the side menu is hidden there). */
export async function signOutViaUi(page: Page): Promise<void> {
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  if (await tabs.isVisible()) {
    await tabs.getByRole("link", { name: "More" }).click();
    await expect(page.getByRole("heading", { name: "More", level: 1 })).toBeVisible({ timeout: 30_000 }); // first compile
  }
  await page.getByRole("button", { name: "Sign out" }).click();
}

/** Signs in with the emailed 6-digit code; the browser ends on the /mfa step. */
export async function signInWithEmailCode(page: Page, email: string, path = "/sign-in"): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page).toHaveURL(/\/sign-in\/verify$/, { timeout: 30_000 }); // first compile in next dev
  const { code } = await latestSignInEmail(email);
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/mfa(\?|$)/);
}

/** Enrols an authenticator on the /mfa page, remembers and returns its secret. */
export async function enrollTotp(page: Page, email: string): Promise<string> {
  await expect(page.getByRole("heading", { name: "Set up two-factor authentication" })).toBeVisible();
  if (await page.getByRole("button", { name: "Set up authenticator" }).isVisible()) {
    await page.getByRole("button", { name: "Set up authenticator" }).click();
  }
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
