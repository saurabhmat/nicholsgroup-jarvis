// Two-factor authentication (T-019): enrol once, challenge at every sign-in, AAL2 required for data, return path.
import { expect, test } from "@playwright/test";
import { completeMfa, enrollTotp, expectLaneHome, nextTotpWindow, signInWithEmailCode, signOutViaUi } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";
import { totp } from "./totp";

test.beforeEach(async () => {
  await clearMailbox();
});

test("enrol, reach the app, then sign in again with the authenticator code", async ({ page }, info) => {
  test.setTimeout(90_000);
  const { member } = personas(info);
  await signInWithEmailCode(page, member);

  // Enrolment starts from a button (not on page load); a wrong code keeps the same QR code and key.
  await expect(page.getByTestId("totp-secret")).toHaveCount(0);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const firstSecret = await page.getByTestId("totp-secret").inputValue();
  await page.getByLabel("Authenticator code").fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("That code is wrong.")).toBeVisible();
  expect(await page.getByTestId("totp-secret").inputValue()).toBe(firstSecret);

  const secret = await enrollTotp(page, member);
  await expectLaneHome(page);
  const lane = await page.request.get("/api/lanes/PKG");
  expect(lane.status()).toBe(200);
  expect(await lane.json()).toEqual({ lane: "PKG" });

  await signOutViaUi(page);
  await expect(page).toHaveURL(/\/sign-in$/, { timeout: 30_000 }); // first compile of the sign-out action

  // Second sign-in: no QR code any more, just the authenticator code; the return path survives both steps.
  await clearMailbox();
  await signInWithEmailCode(page, member, "/sign-in?next=%2F%3Ffrom%3Dtest");
  await expect(page.getByRole("heading", { name: "Enter your authenticator code" })).toBeVisible();
  await expect(page.getByTestId("totp-secret")).toHaveCount(0);
  await nextTotpWindow(page); // the enrolment code cannot be replayed
  await page.getByLabel("Authenticator code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expectLaneHome(page); // "/?from=test" is the entry point and sends the user to their first company
});

test("a member of another lane is refused at AAL2", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the outsider persona is enrolled once per run");
  await signInWithEmailCode(page, "outsider@example.test");
  await completeMfa(page, "outsider@example.test");
  await expect(page.getByText("no company access")).toBeVisible({ timeout: 30_000 }); // first compile of "/"
  const res = await page.request.get("/api/lanes/PKG");
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: "forbidden" });
});

test("a lane the deployment does not serve is refused even for the owner of every lane", async ({ page }, info) => {
  const { secondMember } = personas(info);
  await signInWithEmailCode(page, secondMember);
  await completeMfa(page, secondMember);
  for (const lane of ["APK", "NL", "pkg", "PKG;--"]) {
    const res = await page.request.get(`/api/lanes/${encodeURIComponent(lane)}`);
    expect(res.status()).toBe(403);
  }
});
