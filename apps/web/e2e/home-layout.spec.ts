// T-237 review fix: the Home layout order, measured in a real browser (bounding boxes), not only in the DOM. Synthetic rows in the LOCAL
// database only (example.test addresses; Playwright's global setup resets the local database first). No external call is made.
//   desktop (1280): approvals banner (if present), KPI row, then attention (left, 2/3) | Today above GovCon news (right, 1/3),
//                   Finance (if rendered) below both columns, Projects last.
//   phone (iPhone 15, 393 px): attention, Today, KPIs, news, projects, and no horizontal scroll.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { completeMfa, expectLaneHome, nextTotpWindow, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";
import { sql } from "../scripts/e2e-sql.mjs";

const CID = "00000000-0000-4000-8000-000000000237";
// The phone project's own persona (finance operator) has no connections view, so no KPI tile; the owner sees the Connect QuickBooks tile,
// which gives the KPI row on a phone. The owner's authenticator is enrolled once per run and reused by every project.
const OWNER = "owner@example.test";

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

// A Google connection with one meeting later today (or the all-day event, always today) and three unread important messages.
const seed = () =>
  sql(`insert into core.connections (id, lane_id, provider, external_account_id, status) values ('${CID}', 'PKG', 'google', 'layout-e2e@example.test', 'active');
       insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, title, location, online_meeting_url, start_at, end_at, all_day, start_date, end_date, status, attendees, source_updated_at)
       select 'PKG', '${CID}', 'google', 'primary', 'lay-m2', 'Synthetic layout offsite', null, null,
              (d::timestamp at time zone 'America/New_York'), ((d + 1)::timestamp at time zone 'America/New_York'), true, d, d + 1, 'confirmed', '[]', now()
       from (select (now() at time zone 'America/New_York')::date as d) t;
       insert into comms.message_index (lane_id, connection_id, provider, message_id, from_address, subject, received_at, is_read, is_important, folder, labels, deleted, source_updated_at)
       select 'PKG', '${CID}', 'google', 'lay-' || g, 'sender@example.test', 'Synthetic layout subject ' || g, now() - interval '1 minute', false, true, 'INBOX', '{}', false, now()
       from generate_series(1, 3) g;`);

test.beforeEach(() => {
  cleanup();
});
test.afterAll(cleanup);

type Box = { x: number; y: number; width: number; height: number };
async function box(l: Locator, name: string): Promise<Box> {
  await expect(l, `${name} is laid out`).toBeVisible({ timeout: 30_000 });
  const b = await l.boundingBox();
  if (!b) throw new Error(`${name} has no box`);
  return b;
}
const bottom = (b: Box) => b.y + b.height;
const TOL = 1; // sub-pixel layout

test("desktop: banner above KPI row above attention; Today right of attention, above news; Finance below the columns; Projects last", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop project only");
  test.setTimeout(150_000);
  await signIn(page, personas(info).member);
  seed();
  await page.goto("/PKG");
  await expect(page.getByTestId("home-projects-slot")).toBeVisible({ timeout: 60_000 });
  expect(page.viewportSize()?.width).toBeGreaterThanOrEqual(1024);

  const kpi = await box(page.getByTestId("home-kpi-slot"), "KPI row");
  const attention = await box(page.getByTestId("home-attention-slot"), "attention card");
  const today = await box(page.getByTestId("home-calendar-slot"), "Today");
  const news = await box(page.getByTestId("home-news-slot"), "GovCon news");
  const projects = await box(page.getByTestId("home-projects-slot"), "Projects");

  // Approvals banner (only when something waits): above the KPI row.
  const banner = page.getByTestId("approvals-waiting");
  if ((await banner.count()) > 0) expect(bottom(await box(banner, "approvals banner"))).toBeLessThanOrEqual(kpi.y + TOL);

  expect(bottom(kpi)).toBeLessThanOrEqual(attention.y + TOL);
  expect(bottom(kpi)).toBeLessThanOrEqual(today.y + TOL);
  // Two columns: Today and news are to the right of attention (attention is the wider, 2/3 column); Today starts at the top of the row.
  expect(today.x).toBeGreaterThanOrEqual(attention.x + attention.width - TOL);
  expect(news.x).toBeGreaterThanOrEqual(attention.x + attention.width - TOL);
  expect(attention.width).toBeGreaterThan(today.width * 1.5);
  expect(Math.abs(today.y - attention.y)).toBeLessThanOrEqual(TOL);
  // Right column: Today above GovCon news.
  expect(bottom(today)).toBeLessThanOrEqual(news.y + TOL);
  // Finance (when rendered: QuickBooks connected, finance view) below both columns; Projects last.
  const columnsEnd = Math.max(bottom(attention), bottom(news));
  const finance = page.getByTestId("home-finance");
  let before = columnsEnd;
  if ((await finance.count()) > 0) {
    const f = await box(finance, "Finance section");
    expect(f.y).toBeGreaterThanOrEqual(columnsEnd - TOL);
    before = bottom(f);
  }
  expect(projects.y).toBeGreaterThanOrEqual(before - TOL);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("phone (iPhone 15, 393 px): attention, Today, KPIs, news, projects in that order; no horizontal scroll", async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "phone project only");
  test.setTimeout(150_000);
  await signIn(page, OWNER);
  seed();
  await page.goto("/PKG");
  await expect(page.getByTestId("home-projects-slot")).toBeVisible({ timeout: 60_000 });
  expect(page.viewportSize()?.width).toBeLessThanOrEqual(400); // the iPhone 15 profile is 393 px wide

  const attention = await box(page.getByTestId("home-attention-slot"), "attention card");
  const today = await box(page.getByTestId("home-calendar-slot"), "Today");
  const kpi = await box(page.getByTestId("home-kpi-slot"), "KPI row");
  const news = await box(page.getByTestId("home-news-slot"), "GovCon news");
  const projects = await box(page.getByTestId("home-projects-slot"), "Projects");
  expect(bottom(attention)).toBeLessThanOrEqual(today.y + TOL);
  expect(bottom(today)).toBeLessThanOrEqual(kpi.y + TOL);
  expect(bottom(kpi)).toBeLessThanOrEqual(news.y + TOL);
  expect(bottom(news)).toBeLessThanOrEqual(projects.y + TOL);
  // One column, and the Finance section is not shown on a phone.
  expect(Math.abs(attention.x - today.x)).toBeLessThanOrEqual(TOL);
  await expect(page.getByTestId("home-finance")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
