// The calendar sync run (T-064): pages applied atomically with their cursor, stubs merged without nulling stored fields,
// stale versions skipped, a failed provider call never advances the stored cursor, an expired cursor reloads from scratch,
// a concurrent run is a conflict, and the persisted rows hold metadata only. The index here is the in-memory twin of
// core.cal_events_apply_page (pinned by pgTAP 170).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createGoogleHarness } from "../testing/google-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeGoogle, GOOGLE_BODY_CANARY } from "../testing/msw/google/handlers";
import { http, HttpResponse } from "../testing/msw/index";
import { createCalendarSync } from "./cal-sync";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});
const EXEC = "exec@pubkgroup.example.test";
const TEAM = "c_exec_team@group.calendar.google.com";

function setup() {
  const fake = createFakeGoogle();
  server.use(...fake.handlers);
  const h = createGoogleHarness({ fake, mailboxes: { PKG: [EXEC] } });
  const { row, account } = h.connectGoogle("PKG", EXEC);
  return { fake, h, conn: h.bind(row), account, row };
}
const rowsOf = (h: ReturnType<typeof setup>["h"]) => new Map([...h.events.values()].map((e) => [`${e.calendar_id}/${e.event_id}`, e]));
const cursorOf = (h: ReturnType<typeof setup>["h"], connId: string) => h.cursors.get(`PKG\u0000${connId}\u0000calendar`);

describe("calendar sync run", () => {
  it("loads every synced calendar on the first run, stores one composite cursor, and is quiet on the second", async () => {
    const { h, conn, row } = setup();
    const first = await h.calSync.run("PKG", conn);
    expect(first).toMatchObject({ mode: "full", written: 12, removed: 0, resynced: false, conflict: false, pages: 3 });
    expect(rowsOf(h).size).toBe(12);
    expect(cursorOf(h, conn.id)).toMatch(new RegExp(`^g1\\.${conn.id}\\.c:`));
    expect(h.cursors.has(`PKG\u0000${conn.id}`)).toBe(false); // the mail stream is separate
    expect(row.last_sync_at).not.toBeNull();
    const second = await h.calSync.run("PKG", conn);
    expect(second).toMatchObject({ mode: "incremental", written: 0, removed: 0, pages: 3 });
  });

  it("pages (pageSize 2) with the cursor stored after every page", async () => {
    const { h, conn } = setup();
    const sync = createCalendarSync({ calendar: h.calendar, store: h.calStore, pageSize: 2 });
    const r = await sync.run("PKG", conn);
    expect(r.pages).toBe(6);
    expect(r.written).toBe(12);
    expect(h.calStats.applies).toBe(6);
  });

  it("applies updates, deletions and cancellations on the next run; a stub changes status and keeps the stored fields", async () => {
    const { fake, h, conn, account } = setup();
    await h.calSync.run("PKG", conn);
    const before = rowsOf(h).get("primary/evt-1");
    fake.cancelEvent(account, "primary", "evt-1");
    fake.deleteEvent(account, "primary", "evt-remove");
    fake.updateEvent(account, TEAM, "team-1", { summary: "Moved call" });
    const added = fake.addEvent(account);
    const r = await h.calSync.run("PKG", conn);
    expect(r).toMatchObject({ written: 4, skipped: 0, removed: 0 });
    const m = rowsOf(h);
    expect(m.get("primary/evt-1")).toMatchObject({ status: "cancelled", title: "Synthetic standup", location: "Room 1", start_at: before?.start_at });
    expect(m.get("primary/evt-1")?.attendees).toHaveLength(2);
    expect(m.get("primary/evt-remove")).toMatchObject({ status: "cancelled", start_at: expect.any(String) as string });
    expect(m.get(`${TEAM}/team-1`)?.title).toBe("Moved call");
    expect(m.get(`primary/${added}`)?.status).toBe("confirmed");
    expect(m.size).toBe(13);
  });

  it("a reload of an unchanged calendar changes nothing but is applied; an older Google version never replaces a newer row", async () => {
    const { fake, h, conn, account } = setup();
    await h.calSync.run("PKG", conn);
    const row = [...h.events.values()].find((e) => e.event_id === "team-1");
    if (!row) throw new Error("missing");
    // The stored row is newer than what the next page carries (a reordered replay): skipped.
    row.source_updated_at = "2027-01-01T00:00:00.000Z";
    row.title = "Newer title";
    fake.updateEvent(account, TEAM, "team-1", { summary: "Older title" });
    const r = await h.calSync.run("PKG", conn);
    expect(r).toMatchObject({ written: 0, skipped: 1 });
    expect(rowsOf(h).get(`${TEAM}/team-1`)?.title).toBe("Newer title");
  });

  it("a provider failure leaves the stored cursor untouched and the next run picks the change up", async () => {
    const { fake, h, conn, account } = setup();
    await h.calSync.run("PKG", conn);
    const cursor = cursorOf(h, conn.id);
    const added = fake.addEvent(account);
    fake.setFault(account, "server_error", 2);
    await expect(h.calSync.run("PKG", conn)).rejects.toMatchObject({ info: { kind: "transient" } });
    expect(cursorOf(h, conn.id)).toBe(cursor);
    expect(rowsOf(h).has(`primary/${added}`)).toBe(false);
    const r = await h.calSync.run("PKG", conn);
    expect(r.written).toBe(1);
    expect(rowsOf(h).get(`primary/${added}`)).toBeDefined();
  });

  it("an expired token reloads every calendar from scratch, once, and keeps what was indexed", async () => {
    const { fake, h, conn, account } = setup();
    await h.calSync.run("PKG", conn);
    fake.expireSyncTokens(account, TEAM);
    const r = await h.calSync.run("PKG", conn);
    expect(r).toMatchObject({ mode: "full", resynced: true, written: 12 });
    expect(h.calStats.resets).toBe(1);
    expect(rowsOf(h).size).toBe(12);
    expect((await h.calSync.run("PKG", conn)).mode).toBe("incremental");
  });

  it("a page token that expires (410) during a first full load resets once and restarts", async () => {
    const { h, conn } = setup();
    let failed = false;
    server.use(
      http.get("https://www.googleapis.com/calendar/v3/calendars/:id/events", ({ request }) => {
        if (!failed && new URL(request.url).searchParams.has("pageToken")) {
          failed = true;
          return HttpResponse.json({ error: { code: 410, status: "GONE", errors: [{ reason: "fullSyncRequired" }] } }, { status: 410 });
        }
        return undefined;
      }),
    );
    const sync = createCalendarSync({ calendar: h.calendar, store: h.calStore, pageSize: 2 });
    const r = await sync.run("PKG", conn);
    expect(failed).toBe(true);
    expect(r).toMatchObject({ resynced: true, mode: "full" });
    expect(h.calStats.resets).toBe(1);
    expect(h.events.size).toBe(12); // pages applied before the 410 are applied again, not duplicated
  });

  it("a calendar that leaves the selection loses its rows in the apply; other calendars and the cursor stay", async () => {
    const { fake, h, conn, account } = setup();
    await h.calSync.run("PKG", conn);
    fake.calendar(account, "c_ops_board@group.calendar.google.com").selected = false;
    await h.calSync.run("PKG", conn);
    const calendars = new Set([...h.events.values()].map((e) => e.calendar_id));
    expect(calendars).toEqual(new Set(["primary", TEAM]));
    expect(h.events.size).toBe(10);
  });

  it("a concurrent run that applied first makes this run stop with a conflict and write nothing more", async () => {
    const { fake, h, conn, account } = setup();
    await h.calSync.run("PKG", conn);
    fake.addEvent(account);
    // Another run moves the stored cursor between this run's read and its first apply.
    let moved = false;
    const racing = {
      ...h.calStore,
      async getCursor(laneId: string, c: typeof conn) {
        const read = await h.calStore.getCursor(laneId as "PKG", c);
        if (!moved) {
          moved = true;
          h.cursors.set(`PKG\u0000${c.id}\u0000calendar`, "g1.other-run");
        }
        return read;
      },
    };
    const sync = createCalendarSync({ calendar: h.calendar, store: racing });
    const r = await sync.run("PKG", conn);
    expect(r).toMatchObject({ conflict: true, pages: 0, written: 0 });
    expect(cursorOf(h, conn.id)).toBe("g1.other-run");
  });

  it("only metadata is persisted: no description, no body, no canary anywhere in the stores or the log", async () => {
    const { h, conn } = setup();
    await h.calSync.run("PKG", conn);
    expect(h.contentWriteCount()).toBe(0);
    expect(JSON.stringify([...h.events.values()])).not.toContain(GOOGLE_BODY_CANARY);
    for (const e of h.events.values()) expect(Object.keys(e)).not.toContain("description");
    expect(JSON.stringify(h.logs)).not.toContain(GOOGLE_BODY_CANARY);
  });

  it("refuses a connection of another lane before any request", async () => {
    const { fake, h, conn } = setup();
    const before = fake.state.calendarRequests.length;
    await expect(h.calSync.run("APK", conn)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
    expect(fake.state.calendarRequests.length).toBe(before);
  });
});
