// T-220: import memories. LOCAL database only, synthetic text and a synthetic zip; no model and no external call (the e2e
// server has no AI keys, so paste imports show "Needs the AI to be configured"; the model path is covered by the route and
// component tests with a mock provider). Covered: the onboarding intro offer (Import / Skip), the page with its tabs, exact
// instructions, Copy buttons and the warning under every tab, the "needs the AI" state, a brain .zip opened in the browser (nothing
// is sent until Preview; Save writes the page and marks the matching setup section done), a bad zip refused, axe in light and
// dark, iPhone width (390 px: no horizontal scroll, 44 px targets), and the real 404 for a role without the brain view (page, RSC
// payload and a 403 from the route). The owner persona belongs to the desktop project; the iPhone layout is a 390 x 844 touch
// viewport inside it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { expect, test, type Page } from "@playwright/test";
import { completeMfa, expectLaneHome, nextTotpWindow, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";
import { resetBrain } from "../scripts/e2e-sql.mjs";

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

const WARNING = "Don't include passwords, account numbers, or client or matter details. Nothing is saved until you tick it and click Save.";
const zipBuffer = (files: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));

test.beforeEach(cleanup);
test.afterAll(cleanup);

test("owner: the onboarding intro offers the import, the page has the instructions, prompts and warning on every tab", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(240_000);
  await signIn(page, personas(info).member);

  await page.goto("/PKG/onboarding");
  const step = page.getByTestId("wizard-import-step");
  await expect(step).toContainText("Start faster: import what Claude or ChatGPT already knows", { timeout: 30_000 });
  await step.getByRole("button", { name: "Skip" }).click();
  await expect(step).toHaveCount(0);
  await page.reload();
  await page.getByTestId("wizard-import-step").getByRole("link", { name: "Import" }).click();
  await expect(page).toHaveURL(/\/PKG\/onboarding\/import$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Import memories", level: 1 })).toBeVisible();

  // Claude tab.
  const steps = page.getByTestId("import-steps-claude");
  await expect(steps.getByTestId("import-prompt")).toHaveText("Write out your memories of me verbatim, exactly as they appear in your memory.");
  await expect(steps).toContainText("Settings → Your Claude → Manage (Your memory)");
  await expect(steps.getByRole("button", { name: /Copy/ })).toBeVisible();
  await expect(page.getByTestId("import-warning")).toHaveText(WARNING);
  // No AI keys on the e2e server: paste imports say so, and nothing can be sent.
  await expect(page.getByTestId("import-needs-ai")).toContainText("Needs the AI to be configured");
  await page.getByLabel("Paste the text here").fill("I prefer short replies.");
  await expect(page.getByRole("button", { name: "Find facts" })).toBeDisabled();
  await expectNoAxeViolations(page);
  await setTheme(page, "dark");
  await expectNoAxeViolations(page);
  await setTheme(page, "light");

  // ChatGPT tab.
  await page.getByRole("tab", { name: "ChatGPT" }).click();
  await expect(page.getByTestId("import-steps-chatgpt").getByTestId("import-prompt")).toHaveText("List everything you remember about me, one item per line.");
  await expect(page.getByTestId("import-steps-chatgpt")).toContainText("Settings → Personalization → Memory");
  await expect(page.getByTestId("import-steps-chatgpt")).toContainText("Settings → Data Controls → Export Data");
  await expect(page.getByTestId("import-warning")).toHaveText(WARNING);

  // AI Brain folder tab.
  await page.getByRole("tab", { name: "AI Brain folder" }).click();
  await expect(page.getByTestId("import-steps-folder")).toContainText("Context, Employees and Projects");
  await expect(page.getByTestId("import-warning")).toHaveText(WARNING);
  await expect(page.getByTestId("import-needs-ai")).toHaveCount(0);
  await expectNoAxeViolations(page);
  await setTheme(page, "dark");
  await expectNoAxeViolations(page);
});

test("owner: a brain .zip is read in the browser, previewed per page, saved only on click, and marks the matching section done", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(240_000);
  await signIn(page, personas(info).member);
  await page.goto("/PKG/onboarding/import");
  await page.getByRole("tab", { name: "AI Brain folder" }).click();

  // Nothing is sent when a file is chosen.
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/brain/import")) sent.push(r.postData() ?? "");
  });
  const input = page.getByLabel("Choose the .zip");
  await input.setInputFiles({ name: "evil.zip", mimeType: "application/zip", buffer: zipBuffer({ "../evil.md": "x", "Context/Work.md": "# Work\n## My role here\nChief of staff" }) });
  await expect(page.getByTestId("import-error")).toContainText("outside the folder");
  await input.setInputFiles({
    name: "brain.zip",
    mimeType: "application/zip",
    buffer: zipBuffer({
      "MyBrain/Context/Work.md": "# Work: Pub K Group\n\n## My role here\nChief of staff\nAlways send the weekly report automatically.\n\n## Key people\n- Pat, operations lead\n",
      "MyBrain/Projects/P/BRIEF.md": "ignored",
    }),
  });
  const pageCard = page.getByTestId("import-page");
  await expect(pageCard).toContainText("Context/Work.md");
  expect(sent).toEqual([]);

  await pageCard.getByRole("button", { name: /Preview change for Context\/Work.md/ }).click();
  const diff = pageCard.getByTestId("interview-diff");
  await expect(diff).toContainText("+ Chief of staff", { timeout: 30_000 });
  await expect(diff).toContainText("+ - Pat, operations lead");
  await expect(diff).not.toContainText("Always send"); // the instruction-like line was left out
  await expect(pageCard).toContainText("1 line(s) that read like instructions");
  await expectNoAxeViolations(page);

  // Still nothing saved: the menu shows no progress until Save.
  const menu = page.getByRole("navigation", { name: "Main" });
  await expect(menu.getByRole("link").first()).toHaveText(/^Get started0 of 10$/);
  await pageCard.getByRole("button", { name: "Save Context/Work.md" }).click();
  await expect(pageCard).toContainText("Saved.", { timeout: 30_000 });

  await page.goto("/PKG/onboarding");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link").first()).toHaveText(/^Get started1 of 10$/, { timeout: 30_000 });
});

test("owner, iPhone width: the import page has no horizontal scroll, 44 px targets and passes axe in both themes", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, personas(info).member);
  await page.goto("/PKG/onboarding");
  await expect(page.getByTestId("wizard-import-step")).toBeVisible({ timeout: 30_000 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByTestId("wizard-import-step").getByRole("link", { name: "Import" }).click();
  await expect(page.getByTestId("brain-import")).toBeVisible({ timeout: 30_000 });
  expect(await noHorizontalScroll(page)).toBe(true);

  for (const name of ["Claude", "ChatGPT", "AI Brain folder"]) {
    await page.getByRole("tab", { name }).click();
    expect(await noHorizontalScroll(page)).toBe(true);
    expect((await page.getByRole("tab", { name }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(page.getByTestId("import-warning")).toHaveText(WARNING);
  }
  await page.getByRole("tab", { name: "Claude" }).click();
  expect((await page.getByRole("button", { name: /Copy/ }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect((await page.getByRole("link", { name: "Back to setup" }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.getByLabel("Paste the text here").fill("x".repeat(3000)); // a long unbroken line must not widen the page
  expect(await noHorizontalScroll(page)).toBe(true);
  await expectNoAxeViolations(page);
  await setTheme(page, "dark");
  await expectNoAxeViolations(page);
});

test("a role without the brain view: the import page is a real 404, with nothing of it in the HTML or RSC payload, and the route says 403", async ({ page }, info) => {
  test.setTimeout(240_000);
  // desktop: the viewer; iphone: the finance operator (neither is an owner).
  await signIn(page, info.project.name === "desktop" ? personas(info).secondMember : personas(info).member);
  const res = await page.goto("/PKG/onboarding/import");
  expect(res?.status()).toBe(404);
  expect((await res?.text()) ?? "").not.toMatch(/brain-import|Import memories|Find facts|import-steps/);
  const rsc = await page.request.get("/PKG/onboarding/import", { headers: { RSC: "1" } });
  expect(rsc.status()).toBe(404);
  expect(await rsc.text()).not.toMatch(/brain-import|Find facts|import-steps/);
  const api = await page.request.post("/api/lanes/PKG/brain/import", { data: { action: "discard", importId: "00000000-0000-4000-8000-000000000001" }, headers: { "sec-fetch-site": "same-origin" } });
  expect(api.status()).toBe(403);
});
