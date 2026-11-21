// T-257: Settings -> Connections, "Your Microsoft accounts" beside "Your Google accounts". NOT RUN by the builder (see the PR body, "Needs human").
// Synthetic rows and a synthetic lane_config version are written to the LOCAL database only; the original lane config is put back by a new
// version in afterAll (lane_config is insert-only). No Microsoft call is made anywhere: the connect forms are checked, not submitted (the connect
// flow itself is covered by the connector tests with the MSW fakes of Entra and Graph), and Disconnect is local.
// The spec needs GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and GRAPH_REDIRECT_URI set to synthetic values in the web server's environment for the admin
// consent link; without them the link is simply not drawn and that one test is skipped.
import { expect, test, type Page } from "@playwright/test";
import { completeMfa, expectLaneHome, nextTotpWindow, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";
import { sql } from "../scripts/e2e-sql.mjs";

const MID = "00000000-0000-4000-8000-000000000257";
const GID = "00000000-0000-4000-8000-000000000258";
const OID = "00000000-0000-4000-8000-000000000259";
const TENANT = "11111111-1111-4111-8111-111111111111";

async function signIn(page: Page, email: string): Promise<void> {
  await clearMailbox();
  await signInWithEmailCode(page, email);
  await nextTotpWindow(page);
  await completeMfa(page, email);
  await expectLaneHome(page);
}

const cleanup = () => sql(`delete from core.connections where id in ('${MID}', '${GID}', '${OID}');`);
const saveConfig = () => sql(`create table if not exists public.e2e_t257_saved as select config from core.lane_config_current where lane_id = 'PKG';`);
const setConfig = (providers: string[], withBlock: boolean) =>
  sql(`insert into core.lane_config (lane_id, version, config)
       select 'PKG', c.version + 1,
              jsonb_set(c.config, '{mail,providers}', '${JSON.stringify(providers)}'::jsonb, true)
              || case when ${withBlock} then jsonb_build_object('microsoft', jsonb_build_object('cloud', 'commercial', 'tenant_ids', jsonb_build_array('${TENANT}'))) else '{}'::jsonb end
       from core.lane_config_current c where c.lane_id = 'PKG';`);
const restoreConfig = () =>
  sql(`insert into core.lane_config (lane_id, version, config)
       select 'PKG', c.version + 1, s.config from core.lane_config_current c, public.e2e_t257_saved s where c.lane_id = 'PKG';
       drop table if exists public.e2e_t257_saved;`);
const seed = (id: string, provider: string, address: string, owner: string, status = "active") =>
  sql(`insert into core.connections (id, lane_id, provider, external_account_id, status, owner_user_id) values ('${id}', 'PKG', '${provider}', '${address}', '${status}', (select id from auth.users where email = '${owner}'));`);

test.beforeEach(() => {
  cleanup();
  saveConfig();
});
test.afterEach(() => {
  cleanup();
  restoreConfig();
});

test("both providers enabled: both sections, the owner's Google and Microsoft rows each in its own, Connect posts to the Microsoft route", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(150_000);
  setConfig(["google", "microsoft"], true);
  seed(GID, "google", "ops@example.test", "owner@example.test");
  seed(MID, "microsoft", "ops@example.test", "owner@example.test");
  await signIn(page, personas(info).member);
  await page.goto("/PKG/settings");
  const section = page.getByRole("region", { name: "Connections" });
  await expect(section.getByTestId("google-connection")).toContainText("ops@example.test", { timeout: 30_000 });
  const ms = section.getByTestId("microsoft-connection");
  await expect(ms).toContainText("ops@example.test");
  await expect(ms).not.toContainText("Google");
  await expect(ms.getByRole("button", { name: "Reconnect ops@example.test" }).locator("xpath=ancestor::form")).toHaveAttribute("action", `/api/connect/microsoft/start?lane=PKG&connection=${MID}`);
  await expect(section.getByRole("button", { name: "Connect another Microsoft account" })).toBeVisible();
  await expect(section.getByTestId("microsoft-notes")).toContainText("not how anyone signs in");
});

test("only Google: no Microsoft section, and the start route refuses Microsoft", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(150_000);
  setConfig(["google"], false);
  await signIn(page, personas(info).member);
  await page.goto("/PKG/settings");
  const section = page.getByRole("region", { name: "Connections" });
  await expect(section.getByTestId("google-not-connected")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("microsoft-not-connected")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Microsoft/ })).toHaveCount(0);
  const res = await page.request.post("/api/connect/microsoft/start?lane=PKG", { headers: { origin: new URL(page.url()).origin }, maxRedirects: 0 });
  expect(res.status()).toBe(403);
  expect(res.headers()["location"]).toBeUndefined();
});

test("Microsoft disabled after a connect: the row is paused, no Reconnect; the owner can still disconnect it (local), and sees the fixed instructions", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(150_000);
  setConfig(["google"], false);
  seed(MID, "microsoft", "ops@example.test", "owner@example.test");
  await signIn(page, personas(info).member);
  await page.goto("/PKG/settings");
  const row = page.getByTestId("microsoft-connection");
  await expect(row).toContainText("Paused: Microsoft is not enabled for this company", { timeout: 30_000 });
  await expect(row.getByRole("button", { name: /Reconnect/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Connect Microsoft|Connect another Microsoft/ })).toHaveCount(0);
  await row.getByRole("button", { name: "Disconnect ops@example.test" }).click();
  await expect(page.getByTestId("microsoft-disconnect-confirm")).toContainText("Nothing is sent to Microsoft");
  await page.getByTestId("microsoft-disconnect-confirm").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByTestId("connect-result")).toContainText("Entra admin center (Enterprise apps → the app → Permissions)", { timeout: 30_000 });
  // The row ends `disconnected` (the Vault side is covered by the connector tests; e2e code may not reach the token tables).
  sql(`do $$ begin if (select status from core.connections where id = '${MID}') <> 'disconnected' then raise exception 'not disconnected'; end if; end $$;`);
});

test("another person's Microsoft row is health only for the owner (no button)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(150_000);
  setConfig(["google", "microsoft"], true);
  seed(OID, "microsoft", "other@example.test", "viewer@example.test");
  await signIn(page, personas(info).member);
  await page.goto("/PKG/settings");
  const other = page.getByTestId("microsoft-other-connection");
  await expect(other).toContainText("other@example.test", { timeout: 30_000 });
  await expect(other.getByRole("button")).toHaveCount(0);
});

test("the consent return lands on Settings with a fixed code", async ({ request }) => {
  const ok = await request.get("/api/connect/microsoft/callback?admin_consent=True&tenant=canary-tenant&state=PKG.adminconsent", { maxRedirects: 0 });
  expect(ok.status()).toBe(303);
  expect(ok.headers()["location"]).toBe("/PKG/settings?connect=consent_ok&provider=microsoft");
  const bad = await request.get("/api/connect/microsoft/callback?error=access_denied&error_description=canary&state=PKG.adminconsent", { maxRedirects: 0 });
  expect(bad.headers()["location"]).toBe("/PKG/settings?connect=consent_failed&provider=microsoft");
  // Nothing is stored for a consent return: the route does not touch the database (unit-tested with no session and no state store).
});
