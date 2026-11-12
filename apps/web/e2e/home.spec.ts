// T-200: Home v1. Today's meetings and the attention queue from synthetic rows inserted into the LOCAL database only, on
// a synthetic Google connection of its own; assertions look only for the synthetic titles. (Playwright's global setup
// resets the local database first, like every e2e run.) A finance-only viewer sees none of it. No Google call is made.
import { expect, test, type Page } from "@playwright/test";
import { completeMfa, expectLaneHome, nextTotpWindow, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";
import { sql } from "../scripts/e2e-sql.mjs";

const CID = "00000000-0000-4000-8000-000000000200";
const MEETING = "Synthetic e2e standup";
const ALL_DAY = "Synthetic e2e offsite";

async function signIn(page: Page, email: string): Promise<void> {
  await clearMailbox();
  await signInWithEmailCode(page, email);
  await nextTotpWindow(page);
  await completeMfa(page, email);
  await expectLaneHome(page);
}

const cleanup = () =>
  sql(`delete from cal.event_index where connection_id = '${CID}';
       delete from comms.message_index where connection_id = '${CID}';
       delete from core.connections where id = '${CID}';`);

// A timed meeting 20 minutes ahead (seeded after sign-in, so it is still upcoming when the page loads), an all-day
// event for today in New York, three unread important inbox messages and one already read.
const seed = () =>
  sql(`insert into core.connections (id, lane_id, provider, external_account_id, status) values ('${CID}', 'PKG', 'google', 'home-e2e@example.test', 'active');
       insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, title, location, online_meeting_url, start_at, end_at, all_day, start_date, end_date, status, attendees, source_updated_at)
       select 'PKG', '${CID}', 'google', 'primary', 'e2e-m1', '${MEETING}', 'Synthetic room', 'https://meet.example.test/e2e',
              now() + interval '20 minutes', now() + interval '30 minutes', false, null, null, 'confirmed', '[]', now()
       union all
       select 'PKG', '${CID}', 'google', 'primary', 'e2e-m2', '${ALL_DAY}', null, null,
              (d::timestamp at time zone 'America/New_York'), ((d + 1)::timestamp at time zone 'America/New_York'), true, d, d + 1, 'confirmed', '[]', now()
       from (select (now() at time zone 'America/New_York')::date as d) t;
       insert into comms.message_index (lane_id, connection_id, provider, message_id, from_address, subject, received_at, is_read, is_important, folder, labels, deleted, source_updated_at)
       select 'PKG', '${CID}', 'google', 'e2e-' || g, 'sender@example.test', 'Synthetic subject ' || g, now() - interval '1 minute', g = 4, true, 'INBOX', '{}', false, now()
       from generate_series(1, 4) g;`);

test.beforeEach(() => {
  cleanup();
});
test.afterAll(cleanup);

test("owner: today's calendar, Next 7 days, the KPI strip and the rule-based attention list", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "owner persona is the desktop project's member");
  test.setTimeout(150_000);
  // The timed meeting must still be today in New York when the page loads.
  const nyHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  test.skip(nyHour >= 23, "too close to New York midnight for a meeting 20 minutes ahead to be today");
  await signIn(page, personas(info).member);
  seed();
  await page.goto("/PKG");

  const meetings = page.getByRole("region", { name: "Today's calendar" });
  await expect(meetings.getByText(MEETING)).toBeVisible({ timeout: 30_000 });
  await expect(meetings.getByText(ALL_DAY)).toBeVisible();
  await expect(meetings.getByText("Synthetic room")).toBeVisible();
  await expect(meetings.getByRole("link", { name: "Join" }).first()).toHaveAttribute("href", /^https:\/\//);
  await expect(meetings.getByRole("link", { name: "Join" }).first()).toHaveAttribute("rel", "noopener noreferrer");

  // T-231b: "Needs your attention" lists threads by rule (subject, reason, source) instead of counts; the read message is
  // not listed (nothing unread, nothing waiting).
  const attention = page.getByRole("region", { name: "Needs your attention" });
  await expect(attention.getByText("Synthetic subject 1")).toBeVisible();
  await expect(attention.getByText("sender@example.test", { exact: false }).first()).toBeVisible();
  // T-234 part 2: each item has Reply and Open; Open goes to the thread in Jarvis (never a Google page).
  const firstItem = attention.getByTestId("attention-item").first();
  await expect(firstItem.getByRole("link", { name: "Reply" })).toBeVisible();
  await expect(firstItem.getByRole("link", { name: "Open" })).toHaveAttribute("href", /^\/PKG\/inbox\/[A-Za-z0-9_-]+$/);
  await expect(attention.getByText("Synthetic subject 4")).toHaveCount(0);
  // T-234 part 1: Coverage is no longer on Home (Settings -> Connections); Next 7 days is collapsed until clicked; five KPI tiles.
  await expect(page.getByTestId("coverage-line")).toHaveCount(0);
  const next7 = page.getByRole("button", { name: /Next 7 days/ });
  await expect(next7).toHaveAttribute("aria-expanded", "false");
  await next7.click();
  await expect(next7).toHaveAttribute("aria-expanded", "true");
  // T-234 part 5: the header says when the data was read (silent text, absolute time in the title), and an expanded section
  // survives a full reload (sessionStorage, per company and user).
  await expect(page.getByTestId("home-updated")).toHaveText(/^Updated (just now|\d+ min ago)$/);
  await expect(page.getByTestId("home-updated")).toHaveAttribute("title", /^Data read at /);
  // A real router.refresh() (Next's own app router, as the 5-minute timer calls it): the expanded section stays open and the
  // data-read time moves on. (The Reply drawer is not covered here: the owner persona's Reply needs a live Google mailbox.)
  const readAt = await page.getByTestId("home-updated").getAttribute("title");
  await page.waitForTimeout(1100); // the title has a seconds resolution
  const refreshed = await page.evaluate(() => {
    const r = (window as unknown as { next?: { router?: { refresh?: () => void } } }).next?.router;
    if (!r?.refresh) return false;
    r.refresh();
    return true;
  });
  expect(refreshed, "window.next.router.refresh must exist in this Next build").toBe(true);
  await expect(page.getByTestId("home-updated")).not.toHaveAttribute("title", readAt ?? "");
  await expect(page.getByRole("button", { name: /Next 7 days/ })).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: /Next 7 days/ })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("home-updated")).toHaveText("Updated just now");
  // T-235 part 4: nothing finance-related is connected in this fixture, so no tiles: one slim banner for the owner.
  await expect(page.getByTestId("kpi-tile")).toHaveCount(0);
  const banner = page.getByTestId("home-kpis-banner");
  await expect(banner).toContainText("Connect QuickBooks, Stripe and GoHighLevel to see cash, AR, P&L, MRR and subscribers");
  await expect(banner.getByRole("link", { name: /Settings/ })).toHaveAttribute("href", "/PKG/settings#connections");
  if (info.project.name === "desktop") expect((await banner.boundingBox())?.height ?? 999).toBeLessThan(64); // one line
});

test("a finance-only viewer sees no meetings and no mail counts", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the viewer persona is the desktop project's second member");
  test.setTimeout(150_000);
  await signIn(page, personas(info).secondMember);
  seed();
  await page.goto("/PKG");
  const meetings = page.getByRole("region", { name: "Today's calendar" });
  await expect(meetings.getByText("No calendar to show")).toBeVisible({ timeout: 30_000 });
  const body = page.locator("body");
  await expect(body).not.toContainText(MEETING);
  await expect(body).not.toContainText(ALL_DAY);
  await expect(body).not.toContainText(/unread important/);
  await expect(body).not.toContainText("Synthetic subject");
});

test("phone: the KPI banner fits 390 px (no horizontal scroll)", async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "phone viewport only");
  test.setTimeout(150_000);
  await signIn(page, personas(info).member);
  await page.goto("/PKG");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
  // Nothing connected: the member (owner) sees the slim banner, never five empty tiles; tiles, if any, are one column.
  await expect(page.getByTestId("kpi-tile")).toHaveCount(0);
  await expect(page.getByTestId("home-kpis-banner")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
