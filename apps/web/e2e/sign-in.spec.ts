// Sign-in (T-018): code flow (primary), email link (secondary), redirects, no account discovery, sign-out.
// These tests stop at the two-factor step (T-019), so they never enrol a factor and can use any persona.
import { expect, test } from "@playwright/test";
import { signInWithEmailCode } from "./helpers";
import { clearMailbox, countMessagesTo, latestSignInEmail } from "./mailpit";

const OWNER = "owner@example.test";

test.beforeEach(async () => {
  await clearMailbox();
});

test("signed-out page requests go to /sign-in, keeping a safe return path", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/finance?lane=PKG");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Ffinance%3Flane%3DPKG$/);
});

test("signed-out API requests get 401 JSON, not a redirect", async ({ request }) => {
  const res = await request.get("/api/lanes/PKG", { maxRedirects: 0 });
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: "no_session" });
});

test("the 6-digit code leads to the two-factor step; sign-out from there ends the session", async ({ page }) => {
  await signInWithEmailCode(page, OWNER);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("a wrong code is refused", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(OWNER);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await latestSignInEmail(OWNER);
  await page.getByLabel("Code").fill("000000");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That code is wrong or has expired.")).toBeVisible();
});

test("an unknown address looks the same and gets no email (no account discovery)", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("nobody@example.test");
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page).toHaveURL(/\/sign-in\/verify$/);
  await page.waitForTimeout(1500);
  expect(await countMessagesTo("nobody@example.test")).toBe(0);
});

test("the email link signs in (secondary flow) and also leads to the two-factor step", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(OWNER);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const { link } = await latestSignInEmail(OWNER);
  const url = new URL(link);
  await page.goto(`${url.pathname}${url.search}`); // same path on the test server's port
  await expect(page).toHaveURL(/\/mfa(\?|$)/);
});

test("a used or forged email link is refused", async ({ page }) => {
  await page.goto("/auth/confirm?token_hash=forgedforgedforged&type=email");
  await expect(page).toHaveURL(/\/sign-in\?error=link$/);
  await expect(page.getByText("That sign-in link has expired or was already used.")).toBeVisible();
});

test("an AAL1 session (email code only) gets no lane data and no pages beyond the two-factor step", async ({ page }) => {
  await signInWithEmailCode(page, OWNER);
  const res = await page.request.get("/api/lanes/PKG");
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: "mfa_required" });
  await page.goto("/");
  await expect(page).toHaveURL(/\/mfa(\?|$)/);
});
