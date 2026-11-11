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

test("owner: today's calendar, Coverage and the rule-based attention list", async ({ page }, info) => {
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
  await expect(attention.getByText("Unread from sender@example.test", { exact: false }).first()).toBeVisible();
  await expect(attention.getByText("Synthetic subject 4")).toHaveCount(0);
  await expect(page.getByTestId("coverage-line")).toBeVisible();
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
