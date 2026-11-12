// T-237 part E: an open Reply draft survives Home's real router refresh and a page reload. Synthetic rows in the LOCAL database
// only (own connection id), no Google call. The local stack has no Gmail, so the thread body cannot be read: the drawer must still
// open and be editable, with "Thread preview unavailable" (that is also the product behaviour when a body cannot be read).
// PKG's lane policy stores outbound drafts (seed), so the draft text is kept in sessionStorage and comes back after a reload.
import { expect, test, type Page } from "@playwright/test";
import { completeMfa, expectLaneHome, nextTotpWindow, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";
import { sql } from "../scripts/e2e-sql.mjs";

const CID = "00000000-0000-4000-8000-000000000237";
const TYPED = "Synthetic e2e draft text 7f3a, kept through the refresh.";

async function signIn(page: Page, email: string): Promise<void> {
  await clearMailbox();
  await signInWithEmailCode(page, email);
  await nextTotpWindow(page);
  await completeMfa(page, email);
  await expectLaneHome(page);
}

const cleanup = () =>
  sql(`delete from comms.message_index where connection_id = '${CID}';
       delete from core.connections where id = '${CID}';`);

const seed = () =>
  sql(`insert into core.connections (id, lane_id, provider, external_account_id, status) values ('${CID}', 'PKG', 'google', 'reply-e2e@example.test', 'active');
       insert into comms.message_index (lane_id, connection_id, provider, message_id, thread_id, from_address, from_name, subject, received_at, is_read, is_important, folder, labels, deleted, source_updated_at)
       values ('PKG', '${CID}', 'google', 'e2e-reply-1', 'e2e-thread-1', 'sender@example.test', 'Sam Sender', 'Synthetic reply subject', now() - interval '1 minute', false, true, 'INBOX', '{}', false, now());`);

test.beforeEach(() => {
  cleanup();
});
test.afterAll(cleanup);

test("the Reply drawer keeps an open draft through the router refresh and a reload", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(150_000);
  await signIn(page, personas(info).member);
  seed();
  await page.goto("/PKG");

  const row = page.getByRole("region", { name: "Needs your attention" }).getByTestId("attention-item").filter({ hasText: "Synthetic reply subject" });
  await row.getByTestId("attention-reply").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Header and the unreadable body: the drawer is still usable.
  await expect(dialog.getByTestId("reply-body")).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId("reply-preview-missing")).toContainText("Thread preview unavailable");
  await expect(dialog.getByTestId("reply-full-thread")).toHaveAttribute("href", /^\/PKG\/inbox\/[A-Za-z0-9_-]+$/);
  const body = dialog.getByTestId("reply-body");
  await body.fill(TYPED);
  await expect(dialog.getByTestId("reply-autosave")).toHaveText("Saved just now", { timeout: 10_000 });

  // A real Next router refresh (what the 5-minute timer calls): the drawer stays open and the text stays.
  const refreshed = await page.evaluate(() => {
    const r = (window as unknown as { next?: { router?: { refresh?: () => void } } }).next?.router;
    if (!r?.refresh) return false;
    r.refresh();
    return true;
  });
  expect(refreshed, "window.next.router.refresh must exist in this Next build").toBe(true);
  await page.waitForTimeout(1500);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByTestId("reply-body")).toHaveValue(TYPED);

  // A reload: the lane stores outbound drafts, so the drawer reopens (marker) with the text restored.
  await page.reload();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("reply-body")).toHaveValue(TYPED);
});
