// Sign-in (T-018): code flow (primary), email link (secondary), redirects, no account discovery, sign-out.
import { expect, test } from "@playwright/test";
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

test("sign in with the 6-digit code, then sign out", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(OWNER);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page).toHaveURL(/\/sign-in\/verify$/);

  const { code } = await latestSignInEmail(OWNER);
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("You are signed in.")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("after sign-in, the user returns to the page they asked for", async ({ page }) => {
  await page.goto("/sign-in?next=%2F%3Ffrom%3Dtest");
  await page.getByLabel("Email").fill(OWNER);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const { code } = await latestSignInEmail(OWNER);
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/\?from=test$/);
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

test("the email link signs in (secondary flow)", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(OWNER);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const { link } = await latestSignInEmail(OWNER);
  const url = new URL(link);
  await page.goto(`${url.pathname}${url.search}`); // same path on the test server's port
  await expect(page.getByText("You are signed in.")).toBeVisible();
});

test("a used or forged email link is refused", async ({ page }) => {
  await page.goto("/auth/confirm?token_hash=forgedforgedforged&type=email");
  await expect(page).toHaveURL(/\/sign-in\?error=link$/);
  await expect(page.getByText("That sign-in link has expired or was already used.")).toBeVisible();
});

test("a signed-in session without MFA cannot use lane APIs (403 until T-019 enrolment)", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(OWNER);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const { code } = await latestSignInEmail(OWNER);
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("You are signed in.")).toBeVisible();
  const res = await page.request.get("/api/lanes/PKG");
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: "mfa_required" });
});
