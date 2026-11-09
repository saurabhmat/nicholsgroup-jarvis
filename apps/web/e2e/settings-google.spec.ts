// T-199: Settings → Connections, Google section. Not connected (start form), connected (mailbox, status, sync times) and
// reconnect_required (banner + Reconnect button); a role without connect rights sees no buttons. The connection rows are
// synthetic and inserted into the LOCAL database only. No Google call is made: the form is checked, not submitted
// (the start/callback flow itself is covered by the connector tests with the MSW Google mocks).
import { expect, test, type Page } from "@playwright/test";
import { completeMfa, expectLaneHome, nextTotpWindow, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";
import { sql } from "../scripts/e2e-sql.mjs";

const CID = "00000000-0000-4000-8000-000000000199";

async function signIn(page: Page, email: string): Promise<void> {
  await clearMailbox();
  await signInWithEmailCode(page, email);
  await nextTotpWindow(page); // a code from an earlier spec may still be in its window
  await completeMfa(page, email);
  await expectLaneHome(page);
}

// Only the synthetic row is removed (cursors cascade); a developer's own local Google connection is left alone, and if
// one exists in PKG the specs stop rather than delete it (they need the lane to start with no Google connection).
const cleanup = () => sql(`delete from core.connections where id = '${CID}';`);
const seedConnected = () =>
  sql(`insert into core.connections (id, lane_id, provider, external_account_id, status) values ('${CID}', 'PKG', 'google', 'ops@example.test', 'active');
       insert into core.sync_cursors (lane_id, connection_id, stream, cursor_value, updated_at) values
         ('PKG', '${CID}', 'mail', 'synthetic-cursor-mail', '2026-11-05 14:00:00+00'),
         ('PKG', '${CID}', 'calendar', 'synthetic-cursor-cal', '2026-11-05 14:05:00+00');`);
test.beforeEach(() => {
  cleanup();
  sql(`do $$ begin if exists (select 1 from core.connections where lane_id = 'PKG' and provider = 'google') then
         raise exception 'T-199 e2e: a non-synthetic Google connection exists in local lane PKG; remove it first'; end if; end $$;`);
});
test.afterAll(cleanup);

test("owner: connect form, connected state and reconnect banner", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(150_000);
  await signIn(page, personas(info).member);

  // Not connected: the Connect button posts to the existing start route for this lane; no Disconnect anywhere.
  await page.goto("/PKG/settings");
  const section = page.getByRole("region", { name: "Connections" });
  await expect(section.getByText(/not how anyone signs in/i)).toBeVisible({ timeout: 30_000 });
  const form = section.getByTestId("google-not-connected").locator("form"); // T-230 B: Connections is one list; Google has its own row
  await expect(form).toHaveAttribute("action", "/api/connect/google/start?lane=PKG");
  await expect(form).toHaveAttribute("method", /post/i);
  await expect(section.getByRole("button", { name: "Connect Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: /disconnect/i })).toHaveCount(0);
  await expect(section.getByText(/Third-party connections/)).toBeVisible();

  // Connected, never synced.
  sql(`insert into core.connections (id, lane_id, provider, external_account_id, status) values ('${CID}', 'PKG', 'google', 'ops@example.test', 'active');`);
  await page.goto("/PKG/settings");
  const conn = page.getByTestId("google-connection");
  await expect(conn).toContainText("ops@example.test");
  await expect(conn).toContainText("Connected");
  await expect(conn).toContainText("not synced yet");

  // Synced.
  sql(`insert into core.sync_cursors (lane_id, connection_id, stream, cursor_value, updated_at) values
         ('PKG', '${CID}', 'mail', 'synthetic-cursor-mail', '2026-11-05 14:00:00+00'),
         ('PKG', '${CID}', 'calendar', 'synthetic-cursor-cal', '2026-11-05 14:05:00+00');`);
  await page.goto("/PKG/settings");
  await expect(conn).toContainText("Nov 5, 2026, 9:00 AM ET");
  await expect(conn).toContainText("Nov 5, 2026, 9:05 AM ET");
  await expect(conn).not.toContainText("not synced yet");
  await expect(page.locator("body")).not.toContainText("synthetic-cursor");

  // Reconnect required.
  sql(`update core.connections set status = 'reconnect_required' where id = '${CID}';`);
  await page.goto("/PKG/settings");
  await expect(page.getByRole("alert").filter({ hasText: "Google needs to be reconnected" })).toBeVisible();
  await expect(section.getByRole("button", { name: "Reconnect Google" })).toBeVisible();
  await expect(section.locator("form")).toHaveAttribute("action", "/api/connect/google/start?lane=PKG");
});

test("a role that may not connect sees no Google controls and no connection details", async ({ page }, info) => {
  test.setTimeout(150_000);
  // desktop: viewer; iphone: finance operator.
  const email = info.project.name === "desktop" ? personas(info).secondMember : personas(info).member;
  seedConnected();
  await signIn(page, email);
  await page.goto("/PKG/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeAttached({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Connections" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /google/i })).toHaveCount(0);
  const body = page.locator("body");
  await expect(body).not.toContainText("ops@example.test");
  await expect(body).not.toContainText("Last mail sync");
});

test("admin_technical sees the Google section", async ({ page }, info) => {
  test.skip(info.project.name !== "iphone", "admin_technical persona is the iphone project's second member");
  test.setTimeout(150_000);
  seedConnected();
  await signIn(page, personas(info).secondMember);
  await page.goto("/PKG/settings");
  const section = page.getByRole("region", { name: "Connections" });
  await expect(section.getByTestId("google-connection")).toContainText("ops@example.test", { timeout: 30_000 });
  await expect(section.getByRole("button", { name: "Connect another Google account" })).toBeVisible();
});
