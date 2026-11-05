// Step-up (T-020): a fresh authenticator code is required for sensitive actions; /mfa?reauth=1 provides it.
import { expect, test } from "@playwright/test";
import { completeMfa, expectLaneHome, nextTotpWindow, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";
import { totp } from "./totp";

test("a fresh code passes step-up, an old one does not, and re-entering a code restores it", async ({ page }, info) => {
  test.setTimeout(150_000);
  const { member } = personas(info);
  await clearMailbox();
  await signInWithEmailCode(page, member);
  await nextTotpWindow(page); // a code from an earlier spec may still be in its window
  const secret = await completeMfa(page, member);
  await expectLaneHome(page);
  expect((await page.request.get("/api/session/step-up?maxAge=30")).status()).toBe(200);

  await page.waitForTimeout(31_000);
  const stale = await page.request.get("/api/session/step-up?maxAge=30");
  expect(stale.status()).toBe(403);
  expect(await stale.json()).toEqual({ error: "step_up_required" });

  await page.goto("/mfa?reauth=1");
  await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await nextTotpWindow(page);
  await page.getByLabel("Authenticator code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expectLaneHome(page);
  expect((await page.request.get("/api/session/step-up?maxAge=30")).status()).toBe(200);
});

test("step-up requires a signed-in AAL2 session", async ({ request }) => {
  const res = await request.get("/api/session/step-up");
  expect(res.status()).toBe(401);
});
