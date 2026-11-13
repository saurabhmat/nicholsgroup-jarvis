// T-197: Settings -> Connections, QuickBooks section. Not connected (connect form), connected (masked company id, status, last
// sync per job, class tracking), reconnect banner with Contact support, the disconnect request (confirm, then "waiting for
// approval" with a link to Approvals) and the error-log download links; a role without connect rights sees none of it.
// The connection and sync-run rows are synthetic and inserted into the LOCAL database only. No Intuit call is made: forms and links
// are checked, not followed (the connect flow itself is covered by the connector tests with the MSW QuickBooks mocks).
// RESETS NOTHING ITSELF, but Playwright's global setup resets the local database: run it only when that is acceptable.
import { expect, test, type Page } from "@playwright/test";
import { completeMfa, expectLaneHome, nextTotpWindow, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";
import { sql } from "../scripts/e2e-sql.mjs";

const CID = "00000000-0000-4000-8000-000000000197";
const REALM = "9130000000197";

async function signIn(page: Page, email: string): Promise<void> {
  await clearMailbox();
  await signInWithEmailCode(page, email);
  await nextTotpWindow(page);
  await completeMfa(page, email);
  await expectLaneHome(page);
}

// Only the synthetic connection (and what hangs off it) is removed; a developer's own local QuickBooks connection is left alone,
// and if one exists in PKG the specs stop rather than delete it.
const cleanup = () =>
  sql(`set session_replication_role = replica;
       delete from act.proposed_actions where connection_id = '${CID}';
       delete from core.sync_runs where connection_id = '${CID}';
       delete from core.connector_api_errors where connection_id = '${CID}';
       delete from core.connections where id = '${CID}';`);
const seed = (status = "active", features = '{"class_tracking": true}') =>
  sql(`insert into core.connections (id, lane_id, provider, external_account_id, status, features) values ('${CID}', 'PKG', 'quickbooks', '${REALM}', '${status}', '${features}');
       insert into core.sync_runs (lane_id, connection_id, kind, trigger, status, started_at, finished_at, job) values
         ('PKG', '${CID}', 'incremental', 'schedule', 'succeeded', '2026-11-12 14:00:00+00', '2026-11-12 14:05:00+00', 'sync'),
         ('PKG', '${CID}', 'snapshot', 'schedule', 'succeeded', '2026-11-12 11:00:00+00', '2026-11-12 11:10:00+00', 'reports');`);
test.beforeEach(() => {
  cleanup();
  sql(`do $$ begin if exists (select 1 from core.connections where lane_id = 'PKG' and provider = 'quickbooks') then
         raise exception 'T-197 e2e: a non-synthetic QuickBooks connection exists in local lane PKG; remove it first'; end if; end $$;`);
});
test.afterAll(cleanup);

test("owner: connect form, connected state, class tracking, reconnect banner, disconnect request, error log links", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(180_000);
  await signIn(page, personas(info).member);

  // Not connected: the Connect button posts to the existing start route for this lane.
  await page.goto("/PKG/settings");
  const section = page.getByRole("region", { name: "Connections" });
  const none = section.getByTestId("quickbooks-not-connected");
  await expect(none).toBeVisible({ timeout: 30_000 });
  await expect(none.locator("form")).toHaveAttribute("action", "/api/connect/qbo/start?lane=PKG");
  await expect(none.locator("form")).toHaveAttribute("method", /post/i);
  await expect(none.getByRole("button", { name: "Connect QuickBooks" })).toBeVisible();
  await expect(section.getByRole("button", { name: "Disconnect QuickBooks" })).toHaveCount(0);
  await expect(section.getByRole("link", { name: "Contact support" })).toHaveAttribute("href", "mailto:it@pub-k.org");

  // Connected: masked company id, per-job times, class tracking on.
  seed();
  await page.goto("/PKG/settings");
  const row = page.getByTestId("quickbooks-connection");
  await expect(row).toContainText("Company ID ending 0197");
  await expect(row).toContainText("Connected");
  await expect(row).toContainText("Books: Nov 12, 2026, 9:05 AM ET");
  await expect(row).toContainText("Reports: Nov 12, 2026, 6:10 AM ET");
  await expect(row).toContainText("Finance data: not synced yet");
  await expect(row.getByTestId("qbo-class-tracking")).toHaveText("Class tracking: on");
  await expect(page.locator("body")).not.toContainText(REALM);

  // Class tracking off: the unsplit warning.
  sql(`update core.connections set features = '{"class_tracking": false}' where id = '${CID}';`);
  await page.goto("/PKG/settings");
  await expect(page.getByTestId("qbo-class-tracking-warning")).toContainText("unsplit");

  // Error log: links for this lane with the default 30 days.
  const csv = page.getByTestId("qbo-error-export").getByRole("link", { name: "Download CSV" });
  await expect(csv).toHaveAttribute("href", /^\/api\/lanes\/PKG\/connector-errors\/export\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&format=csv&dataset=errors$/);

  // Reconnect required: banner with Contact support and Reconnect.
  sql(`update core.connections set status = 'reconnect_required' where id = '${CID}';`);
  await page.goto("/PKG/settings");
  const banner = page.getByRole("alert").filter({ hasText: "QuickBooks needs to be reconnected" });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link", { name: "Contact support" })).toHaveAttribute("href", /^mailto:it@pub-k\.org/);
  await expect(page.getByRole("button", { name: "Reconnect QuickBooks" })).toBeVisible();

  // Disconnect: the confirm explains it, asking creates a request, the button is replaced by "waiting for approval".
  sql(`update core.connections set status = 'active' where id = '${CID}';`);
  await page.goto("/PKG/settings");
  await page.getByRole("button", { name: "Disconnect QuickBooks" }).click();
  await expect(page.getByRole("dialog")).toContainText("deletes the saved connection");
  await page.getByRole("button", { name: "Keep it connected" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Disconnect QuickBooks" }).click();
  await page.getByRole("button", { name: "Ask to disconnect" }).click();
  const pending = page.getByTestId("qbo-disconnect-pending");
  await expect(pending).toContainText("Disconnect waiting for approval", { timeout: 30_000 });
  await expect(pending.getByRole("link", { name: "Open Approvals" })).toHaveAttribute("href", "/PKG/approvals");
  await expect(page.getByRole("button", { name: "Disconnect QuickBooks" })).toHaveCount(0);
  await expect(page.getByTestId("quickbooks-connection")).toContainText("Connected"); // nothing changed until it is approved
});

test("a role that may not connect sees no QuickBooks controls and no connection details", async ({ page }, info) => {
  test.setTimeout(150_000);
  const email = info.project.name === "desktop" ? personas(info).secondMember : personas(info).member; // viewer / finance operator
  seed();
  await signIn(page, email);
  await page.goto("/PKG/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeAttached({ timeout: 30_000 });
  await expect(page.getByTestId("quickbooks-connection")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /quickbooks|check connection/i })).toHaveCount(0);
  await expect(page.getByTestId("qbo-error-export")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Company ID ending");
});

test("admin_technical sees the QuickBooks section", async ({ page }, info) => {
  test.skip(info.project.name !== "iphone", "admin_technical persona is the iphone project's second member");
  test.setTimeout(150_000);
  seed();
  await signIn(page, personas(info).secondMember);
  await page.goto("/PKG/settings");
  await expect(page.getByTestId("quickbooks-connection")).toContainText("Company ID ending 0197", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Disconnect QuickBooks" })).toBeVisible();
});
