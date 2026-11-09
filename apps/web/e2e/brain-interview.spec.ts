// T-216: the setup interview at iPhone width, in the assistant chat and in Settings -> AI brain. Local database only,
// synthetic answers. Nothing is saved by the preview; Save writes the page and marks the section done (T-227). No model and no
// external call is involved. The owner persona belongs to the desktop project, so the iPhone layout is checked with a
// 390 x 844 touch viewport inside it.
import { expect, test, type Page } from "@playwright/test";
import { completeMfa, expectLaneHome, nextTotpWindow, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";
import { resetBrain } from "../scripts/e2e-sql.mjs";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

// Each test starts with no brain data in PKG (pages, profiles, T-227 section completions): the database is reset only
// once per run, and saved sections would otherwise show as Done in the next test (H-042).
const cleanup = () => resetBrain("PKG");

async function signIn(page: Page, email: string): Promise<void> {
  await clearMailbox();
  await signInWithEmailCode(page, email);
  await nextTotpWindow(page);
  await completeMfa(page, email);
  await expectLaneHome(page);
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.beforeEach(cleanup);
test.afterAll(cleanup);

test("owner: chat interview at iPhone width: preview writes nothing, Save writes, reload opens the next section and A-1 is Done", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(150_000);
  await signIn(page, personas(info).member);
  await page.goto("/PKG/assistant");
  await page.getByRole("button", { name: "Set up my brain" }).click();
  const flow = page.getByTestId("brain-interview");
  await expect(flow.getByTestId("interview-group")).toBeVisible({ timeout: 30_000 });
  await expect(flow.getByTestId("q-A1")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);

  await flow.getByLabel("Name", { exact: true }).fill("Pat Example");
  await flow.getByLabel("Scope").selectOption("work");
  await flow.getByRole("button", { name: "Preview the change" }).click();
  await expect(flow.getByTestId("interview-diff")).toContainText("+ Pat Example");
  expect(await noHorizontalScroll(page)).toBe(true);
  // Nothing is saved by the preview: the page still has no stored About-Me.
  await page.reload();
  await page.getByRole("button", { name: "Set up my brain" }).click();
  await expect(flow.getByTestId("q-A1")).toBeVisible({ timeout: 30_000 });
  await expect(flow.getByTestId("q-A1-known")).toHaveCount(0);

  await flow.getByLabel("Name", { exact: true }).fill("Pat Example");
  await flow.getByLabel("Scope").selectOption("work");
  await flow.getByRole("button", { name: "Preview the change" }).click();
  const save = flow.getByRole("button", { name: "Save", exact: true });
  const box = await save.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44); // tap target
  await save.click();
  await expect(flow.getByTestId("interview-notice")).toContainText("Saved");

  // T-227: Save stored A-1 ("About you") as done, so reopening starts at the next open section (chat routing skips
  // finished sections). A-1 shows Done under All sections, and Change opens it with the saved answer.
  await page.reload();
  await page.getByRole("button", { name: "Set up my brain" }).click();
  const group = flow.getByTestId("interview-group");
  await expect(group).toBeVisible({ timeout: 30_000 });
  await expect(group).not.toHaveAttribute("data-group", "A-1");
  await flow.getByRole("button", { name: "All sections" }).click();
  const aboutYou = flow.getByTestId("section-A-1");
  await expect(aboutYou).toContainText("About you");
  await expect(aboutYou).toContainText("Done");
  await expect(aboutYou).not.toContainText("Not done");
  await aboutYou.getByRole("button", { name: "Change" }).click();
  await expect(group).toHaveAttribute("data-group", "A-1");
  await expect(flow.getByLabel("Name", { exact: true })).toHaveValue("Pat Example");
});

test("owner: Settings -> AI brain lists the sections and opens the wizard, which links to Connections for a missing source", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(150_000);
  await signIn(page, personas(info).member);
  await page.goto("/PKG/settings");
  const section = page.getByRole("region", { name: "AI brain" });
  await expect(section.getByTestId("brain-status-list")).toBeVisible({ timeout: 30_000 }); // T-226: a compact list, not the interview
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.goto("/PKG/onboarding?step=B-1"); // first Personal Assistant section
  await expect(page.getByTestId("q-B2")).toBeVisible({ timeout: 30_000 });
  // No connect button anywhere in the interview: only a link to Settings -> Connections.
  await expect(page.getByTestId("brain-wizard").getByRole("button", { name: /connect/i })).toHaveCount(0);
});

test("a viewer sees no AI brain section", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "viewer persona is the desktop project's second member");
  test.setTimeout(150_000);
  await signIn(page, personas(info).secondMember);
  await page.goto("/PKG/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeAttached({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: "AI brain" })).toHaveCount(0);
});
