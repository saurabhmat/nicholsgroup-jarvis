// T-023 in the browser: the app shell, the company switcher and the lane in the URL, on desktop and iPhone viewports.
import { expect, test } from "@playwright/test";
import { completeMfa, expectLaneHome, nextTotpWindow, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test("a member sees the shell, a switcher with only the allowed lane, and a 404 for any other lane", async ({ page, isMobile }, info) => {
  const { member } = personas(info);
  await clearMailbox();
  await signInWithEmailCode(page, member);
  await nextTotpWindow(page);
  await completeMfa(page, member);
  await expectLaneHome(page);

  const switcher = page.locator("[data-slot=lane-switcher]:visible");
  await expect(switcher).toHaveCount(1);
  await expect(switcher).toContainText("Pub K Group");
  await expect(page.getByText("Ask Pub K")).toHaveCount(0);
  await expect(page.getByText("All companies")).toHaveCount(0);

  if (isMobile) {
    const tabs = page.getByRole("navigation", { name: "Tabs" });
    await expect(tabs.getByRole("link")).toHaveText(["Home", "Approvals", "Inbox", "Ask", "More"]);
    await tabs.getByRole("link", { name: "Inbox" }).click();
  } else {
    const menu = page.getByRole("navigation", { name: "Main" });
    await expect(menu.getByRole("link")).toHaveText(["Home", "Finance", "Inbox", "Calendar", "Approvals", "Assistant", "Projects", "Settings"]);
    await menu.getByRole("link", { name: "Inbox" }).click();
  }
  await expect(page).toHaveURL(/\/PKG\/inbox$/, { timeout: 30_000 }); // first visit compiles the route in next dev
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(page.getByText("Sample data")).toHaveCount(0);

  // Owner of every seeded lane, but only PKG is enabled: another lane's URL is a 404, same as an unknown lane.
  for (const lane of ["APK", "NL", "ZZZ"]) {
    const res = await page.goto(`/${lane}/finance`);
    expect(res?.status(), lane).toBe(404);
    await expect(page.getByText("Page not found")).toBeVisible();
    await expect(page.getByText("Pub K Group")).toHaveCount(0);
  }
});

test("a user in no lane is not shown PKG and its URL is a 404", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the outsider persona is enrolled once per run");
  await signInWithEmailCode(page, "outsider@example.test");
  await nextTotpWindow(page);
  await completeMfa(page, "outsider@example.test");
  await expect(page.getByText("no company access")).toBeVisible();
  const res = await page.goto("/PKG");
  expect(res?.status()).toBe(404);
  await expect(page.getByText("Pub K Group")).toHaveCount(0);
});
