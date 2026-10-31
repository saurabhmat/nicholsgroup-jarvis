// Two-factor authentication (T-019): enrol once, challenge at every sign-in, AAL2 required for data, return path.
import { expect, test } from "@playwright/test";
import { enrollTotp, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";
import { totp } from "./totp";

test.beforeEach(async () => {
  await clearMailbox();
});

test("enrol, reach the app, then sign in again with the authenticator code", async ({ page }, info) => {
  const { member } = personas(info);
  await signInWithEmailCode(page, member);

  // A wrong code during enrolment is refused; the page offers a new QR code.
  await page.getByLabel("Authenticator code").fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("That code is wrong.")).toBeVisible();

  const secret = await enrollTotp(page);
  await expect(page.getByText("You are signed in.")).toBeVisible();
  const lane = await page.request.get("/api/lanes/PKG");
  expect(lane.status()).toBe(200);
  expect(await lane.json()).toEqual({ lane: "PKG" });

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  // Second sign-in: no QR code any more, just the authenticator code; the return path survives both steps.
  await clearMailbox();
  await signInWithEmailCode(page, member, "/sign-in?next=%2F%3Ffrom%3Dtest");
  await expect(page.getByRole("heading", { name: "Enter your authenticator code" })).toBeVisible();
  await expect(page.getByTestId("totp-secret")).toHaveCount(0);
  await page.getByLabel("Authenticator code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/\?from=test$/);
  await expect(page.getByText("You are signed in.")).toBeVisible();
});

test("a member of another lane is refused at AAL2", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the outsider persona is enrolled once per run");
  await signInWithEmailCode(page, "outsider@example.test");
  await enrollTotp(page);
  await expect(page.getByText("You are signed in.")).toBeVisible();
  const res = await page.request.get("/api/lanes/PKG");
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: "forbidden" });
});

test("a lane the deployment does not serve is refused even for the owner of every lane", async ({ page }, info) => {
  const { secondMember } = personas(info);
  await signInWithEmailCode(page, secondMember);
  await enrollTotp(page);
  for (const lane of ["APK", "NL", "pkg", "PKG;--"]) {
    const res = await page.request.get(`/api/lanes/${encodeURIComponent(lane)}`);
    expect(res.status()).toBe(403);
  }
});
