// T-230 B: layout screenshots (not part of e2e:brain). Signs in as the owner persona (synthetic local seed) and saves PNGs.
// Run: SHOTS=1 SHOTS_OUT=/abs/dir [SHOTS_SET=before] E2E_SPECS=e2e/screenshots.spec.ts pnpm e2e:brain --project=desktop
// SHOTS_SET=before: Home and Settings at 1440 only. SHOTS_SET=home (T-235): Home at 1440, 1920 and iPhone. Default: the full set.
// LOCAL stack only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { completeMfa, nextTotpWindow, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";

test.skip(!process.env.SHOTS || !process.env.SHOTS_OUT, "screenshot run only (SHOTS=1 SHOTS_OUT=dir)");
test.setTimeout(600_000);

const OUT = process.env.SHOTS_OUT ?? "";
const BEFORE = process.env.SHOTS_SET === "before";
const HOME_ONLY = process.env.SHOTS_SET === "home";
const GREETING = /^Good (morning|afternoon|evening)/;
const SIZES = [
  { key: "1440", width: 1440, height: 900 },
  { key: "1920", width: 1920, height: 1080 },
  { key: "iphone", width: 390, height: 844 },
] as const;

async function settle(page: Page, heading: RegExp): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: heading }).first()).toBeAttached({ timeout: 30_000 });
  await expect(page.getByTestId("page-skeleton")).toHaveCount(0, { timeout: 30_000 });
  await page.waitForTimeout(800);
}

test("capture screenshots", async ({ page }, info) => {
  mkdirSync(OUT, { recursive: true });
  const { member } = personas(info);
  await clearMailbox();
  await signInWithEmailCode(page, member);
  await nextTotpWindow(page);
  await completeMfa(page, member);
  await expect(page).toHaveURL(/\/PKG$/, { timeout: 30_000 });
  await page.emulateMedia({ colorScheme: "light" });

  const shot = (name: string) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  const sizes = BEFORE ? [SIZES[0]] : SIZES;
  for (const s of sizes) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.goto("/PKG");
    await settle(page, GREETING);
    await shot(`home-${s.key}-light`);
    if (HOME_ONLY) continue;
    await page.goto("/PKG/settings");
    await settle(page, /^Settings/);
    await shot(`settings-${s.key}-light`);
    if (BEFORE) continue;
    await page.goto("/PKG/onboarding");
    await settle(page, /^Set up your/);
    await shot(`get-started-intro-${s.key}-light`);
    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.getByTestId("interview-group")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);
    await shot(`get-started-wizard-${s.key}-light`);
    await page.goto("/PKG/onboarding/import");
    await page.waitForTimeout(2500);
    await shot(`import-${s.key}-light`);
  }
  if (HOME_ONLY) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/PKG");
    await settle(page, GREETING);
    await shot("home-1440-dark");
    return;
  }
  if (!BEFORE) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" }); // theme follows the device setting
    await page.goto("/PKG");
    await settle(page, GREETING);
    await shot("home-1440-dark");
    await page.goto("/PKG/settings");
    await settle(page, /^Settings/);
    await shot("settings-1440-dark");
  }
});
