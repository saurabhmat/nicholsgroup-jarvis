// T-226: the guided onboarding. Menu entry (desktop) / More row + Home banner (iPhone width), the wizard (preview writes
// nothing, Save writes, Skip keeps "Not provided", deep link), Settings (no placeholder, AI brain status list, Composio missing
// names, fixed error banner, origin notice) and an axe check in light and dark. LOCAL database only, synthetic answers; no
// model and no external call. The owner persona belongs to the desktop project, so the iPhone layout is checked with a
// 390 x 844 touch viewport inside it; the iphone project's persona (no brain view) must see none of it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { completeMfa, expectLaneHome, nextTotpWindow, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";
import { resetBrain } from "../scripts/e2e-sql.mjs";

// Each test starts with no brain data in PKG (pages, profiles, T-227 section completions): the database is reset only
// once per run, and saved sections would otherwise show as Done in the next test (H-042).
const cleanup = () => resetBrain("PKG");
const AXE = readFileSync(path.resolve(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");

async function signIn(page: Page, email: string): Promise<void> {
  await clearMailbox();
  await signInWithEmailCode(page, email);
  await nextTotpWindow(page);
  await completeMfa(page, email);
  await expectLaneHome(page);
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** axe on the whole page (WCAG 2 A/AA); fails with the rule ids and the first nodes. */
async function expectNoAxeViolations(page: Page): Promise<void> {
  await page.addScriptTag({ content: AXE });
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (c: Document, o: unknown) => Promise<{ violations: { id: string; nodes: { target: unknown }[] }[] }> } }).axe;
    const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    return r.violations.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target) }));
  });
  expect(violations).toEqual([]);
}

const setTheme = (page: Page, theme: "light" | "dark") => page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);

test.beforeEach(cleanup);
test.afterAll(cleanup);

test("owner, desktop: Get started is first in the menu, the wizard previews, saves on click, skips and deep-links", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(240_000);
  await signIn(page, personas(info).member);

  const menu = page.getByRole("navigation", { name: "Main" });
  const first = menu.getByRole("link").first();
  await expect(first).toHaveText(/^Get started0 of 10$/);
  await first.click();
  await expect(page).toHaveURL(/\/PKG\/onboarding$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Set up your brain", level: 1 })).toBeVisible();
  await expect(first).toHaveAttribute("aria-current", "page");

  // Intro: three lines and Start.
  const intro = page.getByTestId("wizard-intro");
  await expect(intro).toContainText("never stores passwords, account numbers, or client or matter details", { timeout: 30_000 });
  await expect(intro).toContainText("Nothing is saved until you approve it");
  await expectNoAxeViolations(page);
  await setTheme(page, "dark");
  await expectNoAxeViolations(page);
  await setTheme(page, "light");

  await intro.getByRole("button", { name: "Start" }).click();
  const rail = page.getByTestId("wizard-rail");
  await expect(rail.getByRole("button")).toHaveCount(10);
  await expect(rail.locator("[aria-current=step]")).toHaveCount(1);
  await expect(page.getByTestId("q-A1")).toBeVisible();
  await expect(page.getByTestId("wizard-step-label")).toBeHidden(); // desktop shows the rail instead

  // Preview writes nothing; Save & continue does.
  await page.getByLabel("Name", { exact: true }).fill("Pat Example");
  await page.getByLabel("Scope").selectOption("work");
  await page.getByLabel("First task").fill("Tidy my week");
  await page.getByRole("button", { name: "Preview change" }).click();
  await expect(page.getByTestId("interview-diff")).toContainText("+ Pat Example");
  await expectNoAxeViolations(page);
  await page.reload();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("q-A1")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("q-A1-known")).toHaveCount(0); // still nothing stored after the preview + reload
  await page.getByLabel("Name", { exact: true }).fill("Pat Example");
  await page.getByLabel("Scope").selectOption("work");
  await page.getByLabel("First task").fill("Tidy my week");
  await page.getByRole("button", { name: "Preview change" }).click();
  await page.getByRole("button", { name: "Save & continue" }).click();
  await expect(page.getByTestId("interview-notice")).toContainText("Saved: About you", { timeout: 30_000 });
  await expect(page.getByTestId("interview-group")).toHaveAttribute("data-group", "A-2");

  // Back returns to the saved section (keeping typed answers is covered by the component tests); Skip for now saves nothing.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("q-A1-known")).toContainText("Already set:");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("interview-group")).toHaveAttribute("data-group", "A-2");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByTestId("interview-group")).toHaveAttribute("data-group", "A-3");

  // Deep link: a valid step opens exactly that step; an unknown one falls back to the first incomplete step.
  await page.goto("/PKG/onboarding?step=B-3");
  await expect(page.getByTestId("interview-group")).toHaveAttribute("data-group", "B-3", { timeout: 30_000 });
  await page.goto("/PKG/onboarding?step=%3Cscript%3E");
  await expect(page.getByTestId("interview-group")).toHaveAttribute("data-group", "A-2", { timeout: 30_000 });
  await expect(menu.getByRole("link").first()).toHaveText(/^Get started1 of 10$/);

  // Nothing to add: marks a section done without writing anything (T-227).
  await page.goto("/PKG/onboarding?step=B-3");
  await page.getByRole("button", { name: "Nothing to add" }).click();
  await expect(page.getByTestId("interview-notice")).toContainText("Marked as done: Calendar, finance and approvals", { timeout: 30_000 });
  await expect(page.getByTestId("wizard-progress-text")).toHaveText("2 of 10 saved");

  // Finish screen: skip to the end.
  await page.goto("/PKG/onboarding?step=B-6");
  await page.getByRole("button", { name: "Skip for now" }).click();
  const finish = page.getByTestId("wizard-finish");
  await expect(finish).toBeVisible({ timeout: 30_000 });
  await expect(finish.getByText("Not provided").first()).toBeVisible();
  await expect(finish.getByRole("button", { name: "Run test briefing" })).toBeDisabled();
  await expect(finish).toContainText("Arrives with the daily briefing");
  await expect(finish.getByRole("link", { name: "Ask Jarvis" })).toHaveAttribute("href", "/PKG/assistant");
  await expect(finish.getByRole("link", { name: /Edit/ }).first()).toHaveAttribute("href", /\/PKG\/onboarding\?step=/);
  await expectNoAxeViolations(page);
  await setTheme(page, "dark");
  await expectNoAxeViolations(page);
});

test("owner, iPhone width: More row, Home banner, Step N of 10 and a sticky Save above the tab bar", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, personas(info).member);

  // No new tab; Home banner while incomplete.
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  await expect(tabs.getByRole("link")).toHaveText(["Home", "Approvals", "Inbox", "Ask", "More"]);
  const banner = page.getByTestId("onboarding-banner");
  await expect(banner).toContainText("Finish setting up Jarvis (0 of 10)");
  expect(await noHorizontalScroll(page)).toBe(true);

  // Top of More.
  await tabs.getByRole("link", { name: "More" }).click();
  await expect(page.getByRole("heading", { name: "More", level: 1 })).toBeVisible({ timeout: 30_000 });
  const rows = page.getByRole("main").getByRole("listitem");
  await expect(rows.first()).toContainText("Get started");
  await expect(rows.first()).toContainText("0 of 10");
  await rows.first().getByRole("link").click();
  await expect(page).toHaveURL(/\/PKG\/onboarding$/, { timeout: 30_000 });

  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("wizard-step-label")).toHaveText("Step 1 of 10");
  await expect(page.getByTestId("wizard-rail")).toBeHidden();
  await expect(page.getByTestId("q-A1")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);

  // The action bar sticks above the tab bar, with 44 px targets, and the primary action is full width.
  await page.getByLabel("Name", { exact: true }).fill("Pat Example");
  await page.getByLabel("Scope").selectOption("work");
  const actions = page.getByTestId("wizard-actions");
  await page.getByRole("button", { name: "Preview change" }).click();
  await expect(page.getByTestId("interview-diff")).toBeVisible();
  const save = page.getByRole("button", { name: "Save & continue" });
  await save.scrollIntoViewIfNeeded();
  const aboveTabs = async () => {
    const bar = await actions.boundingBox();
    const tab = await tabs.boundingBox();
    return Boolean(bar && tab && bar.y >= 0 && bar.y + bar.height <= tab.y + 1 && bar.y + bar.height <= 844);
  };
  await expect.poll(aboveTabs).toBe(true);
  expect((await save.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.evaluate(() => window.scrollTo(0, 0)); // scrolled to the top, the bar is still on screen above the tabs
  await expect.poll(aboveTabs).toBe(true);
  await expectNoAxeViolations(page);
  await setTheme(page, "dark");
  await expectNoAxeViolations(page);
});

test("owner: Settings has no placeholder, a status list for AI brain, Composio setting names, the fixed error banner and the origin notice", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(240_000);
  await signIn(page, personas(info).member);

  await page.goto("/PKG/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeAttached({ timeout: 30_000 });
  await expect(page.getByText("Settings are not set up yet")).toHaveCount(0);

  const brain = page.getByRole("region", { name: "AI brain" });
  const list = brain.getByTestId("brain-status-list");
  await expect(list.getByRole("listitem")).toHaveCount(10);
  await expect(brain.getByTestId("brain-interview")).toHaveCount(0); // the full interview lives on the onboarding page
  await expect(list.getByRole("listitem").first()).toContainText("Not done");
  await expect(brain.getByRole("link", { name: "Continue setup" })).toHaveAttribute("href", "/PKG/onboarding");
  await list.getByRole("link", { name: /Edit/ }).nth(2).click();
  await expect(page).toHaveURL(/\/PKG\/onboarding\?step=A-3$/, { timeout: 30_000 });
  await expect(page.getByTestId("interview-group")).toHaveAttribute("data-group", "A-3", { timeout: 30_000 });

  await page.goto("/PKG/settings");
  // The page is opened on 127.0.0.1 while NEXT_PUBLIC_APP_URL is localhost: hosts only (shown with the Google section).
  await expect(page.getByRole("region", { name: "Connections" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("origin-notice")).toHaveText("You're on 127.0.0.1:3100. Open localhost:3100 to connect accounts.");

  // The e2e server has no Composio settings at all (no project key): T-230 B shows one line, setting NAME only, instead of per-toolkit rows.
  await expect(page.getByText("Composio not configured on this server (COMPOSIO_API_KEY not set)")).toBeVisible();
  await expect(page.getByTestId("composio-gmail")).toHaveCount(0);
  await expect(page.getByTestId("composio-googlecalendar")).toHaveCount(0);

  // The fixed banner, chosen by an allowlisted code; anything else is ignored.
  await page.goto("/PKG/settings?error=google_env");
  const banner = page.getByTestId("connect-result");
  await expect(banner).toContainText("Google isn't configured on this server.", { timeout: 30_000 });
  await expect(banner).toContainText("Check GOOGLE_REDIRECT_URI and NEXT_PUBLIC_APP_URL (same https domain) and redeploy.");
  await page.goto("/PKG/settings?error=%3Cb%3Eyour%20words%3C%2Fb%3E");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeAttached({ timeout: 30_000 });
  await expect(page.getByTestId("connect-result")).toHaveCount(0);
  await expect(page.getByText("your words")).toHaveCount(0);
  await expectNoAxeViolations(page);
  await setTheme(page, "dark");
  await expectNoAxeViolations(page);
});

test("a role without the brain view sees no Get started, no banner, and the onboarding page is a 404", async ({ page }, info) => {
  test.setTimeout(240_000);
  // desktop: the viewer; iphone: the finance operator (neither is an owner).
  await signIn(page, info.project.name === "desktop" ? personas(info).secondMember : personas(info).member);
  await expect(page.getByText("Get started")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-banner")).toHaveCount(0);
  // H-042: a real 404 status (decided by the proxy before streaming), and nothing of the wizard in the HTML or in the
  // RSC payload a client-side navigation would fetch.
  const res = await page.goto("/PKG/onboarding");
  expect(res?.status()).toBe(404);
  expect((await res?.text()) ?? "").not.toMatch(/brain-wizard|wizard-intro|Set up your|About-Me|q-A1/);
  await expect(page.getByTestId("brain-wizard")).toHaveCount(0);
  const rsc = await page.request.get("/PKG/onboarding?step=A-1", { headers: { RSC: "1" } });
  expect(rsc.status()).toBe(404);
  expect(await rsc.text()).not.toMatch(/brain-wizard|wizard-intro|About-Me|q-A1/);

  // T-230 A review: a client-side navigation or prefetch (script fetch, Sec-Fetch-Dest: empty) skips the proxy's status check,
  // so the page's own check is what refuses it. Whatever the status, the payload carries nothing of the wizard or the import.
  for (const path of ["/PKG/onboarding", "/PKG/onboarding?step=A-1", "/PKG/onboarding/import"]) {
    for (const prefetch of [false, true]) {
      const res = await page.request.get(path, { headers: { RSC: "1", "Sec-Fetch-Dest": "empty", ...(prefetch ? { "Next-Router-Prefetch": "1" } : {}) } });
      const body = await res.text();
      expect(body, `${path} prefetch=${String(prefetch)}`).not.toMatch(/brain-wizard|wizard-intro|Set up your|About-Me|q-A1|brain-import|Import memories|Find facts|import-steps|Step \d+ of/);
    }
  }
});
