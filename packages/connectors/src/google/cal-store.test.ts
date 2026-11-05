// The calendar index store (T-064) over core.cal_events_apply_page / sync_cursor_*: lane-bound, records re-validated,
// RPC arguments exact, database messages never passed on, a compare-and-swap on every chunk. The functions themselves
// are pinned by pgTAP 170.
import { describe, expect, it, vi } from "vitest";
import type { CalendarSyncResult, EventMeta } from "../comms/schemas";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import type { Connection } from "../contract/schemas";
import { createCalendarIndexStore } from "./cal-store";

const row: Connection<"google"> = {
  id: "00000000-0000-4000-8000-000000000641",
  lane_id: "PKG",
  provider: "google",
  external_account_id: "exec@pubkgroup.example.test",
  status: "active",
  features: {},
  features_checked_at: null,
  token_expires_at: null,
  last_sync_at: null,
  last_error: null,
};
const conn = mintLaneBoundConnection<"google">(row);
const event = (id: string): EventMeta => ({
  calendar_id: "primary",
  event_id: id,
  ical_uid: null,
  source_url: "https://www.google.com/calendar/event?eid=x",
  title: "T",
  location: null,
  organizer_email: null,
  organizer_name: null,
  start_at: "2026-10-21T18:00:00.000Z",
  end_at: "2026-10-21T19:00:00.000Z",
  all_day: false,
  start_date: null,
  end_date: null,
  timezone: "America/New_York",
  attendees: [],
  status: "confirmed",
  recurring_event_id: null,
  original_start_at: null,
  online_meeting_url: null,
  source_updated_at: "2026-10-01T10:00:00.000Z",
});
const page = (over: Partial<CalendarSyncResult> = {}): CalendarSyncResult => ({ upserts: [event("e1")], removals: [{ calendar_id: "primary", event_id: "e0" }], nextCursor: { value: "g1.x.c:1" }, hasMore: false, fullResyncRequired: false, ...over });

function fake(result: { data?: unknown; error?: { code?: string; message?: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const schema = { rpc: async (fn: string, args: Record<string, unknown>) => (calls.push({ fn, args }), { data: result.data ?? null, error: result.error ?? null }) };
  const clientFor = vi.fn(async () => ({ schema: () => schema }) as never);
  return { calls, clientFor };
}
const NONE = { expected: null } as const;
const kind = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { info?: { kind?: string; message?: string } }).info;
  }
  return null;
};

describe("applyPage", () => {
  it("sends exactly lane, connection, removals, events, cursors and the completion flag - no revive, no body field", async () => {
    const { calls, clientFor } = fake({ data: { removed: 1, written: 1, skipped: 0 } });
    const counts = await createCalendarIndexStore(clientFor).applyPage("PKG", conn, page(), { expected: { value: "g1.x.c:0" }, complete: true });
    expect(counts).toEqual({ removed: 1, written: 1, skipped: 0, conflict: false });
    expect(clientFor).toHaveBeenCalledWith("PKG");
    expect(calls).toEqual([
      { fn: "cal_events_apply_page", args: { p_lane: "PKG", p_connection_id: row.id, p_removals: [{ calendar_id: "primary", event_id: "e0" }], p_upserts: [event("e1")], p_expected_cursor: "g1.x.c:0", p_cursor: "g1.x.c:1", p_complete: true, p_drop_calendars: [] } },
    ]);
  });

  it("sends the calendars that left the selection with the first chunk only", async () => {
    const { calls, clientFor } = fake({ data: { removed: 0, written: 0, skipped: 0 } });
    const ups = Array.from({ length: 600 }, (_v, i) => event(`e${String(i)}`));
    await createCalendarIndexStore(clientFor).applyPage("PKG", conn, page({ upserts: ups, dropCalendars: ["c_old@group.calendar.google.com"] }), NONE);
    expect(calls.map((c) => c.args.p_drop_calendars)).toEqual([["c_old@group.calendar.google.com"], []]);
  });

  it("refuses a record with a description-like extra field before any call (strict metadata)", async () => {
    const { calls, clientFor } = fake({ data: {} });
    const bad = { ...event("e1"), description: "agenda" } as unknown as EventMeta;
    await expect(createCalendarIndexStore(clientFor).applyPage("PKG", conn, page({ upserts: [bad] }), NONE)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("refuses a resync answer, an oversized page, a forged connection and another lane's connection", async () => {
    const { calls, clientFor } = fake({ data: {} });
    const store = createCalendarIndexStore(clientFor);
    expect((await kind(store.applyPage("PKG", conn, page({ fullResyncRequired: true, nextCursor: null, upserts: [], removals: [] }), NONE)))?.kind).toBe("invalid_input");
    expect((await kind(store.applyPage("PKG", conn, page({ upserts: Array.from({ length: 20_001 }, (_v, i) => event(`e${String(i)}`)) }), NONE)))?.kind).toBe("invalid_input");
    expect((await kind(store.applyPage("PKG", { ...conn } as never, page(), NONE)))?.kind).toBe("lane_mismatch");
    expect((await kind(store.applyPage("APK", conn, page(), NONE)))?.kind).toBe("lane_mismatch");
    expect(calls).toEqual([]);
  });

  it("maps database errors to fixed messages and never passes the database text on", async () => {
    for (const [code, expected] of [["42501", "forbidden"], ["23514", "invalid_input"], ["22023", "invalid_input"], ["22007", "invalid_input"], ["57014", "transient"]] as const) {
      const { clientFor } = fake({ error: { code, message: "secret row detail: title=Quarterly layoffs" } });
      const info = await kind(createCalendarIndexStore(clientFor).applyPage("PKG", conn, page(), NONE));
      expect(info?.kind).toBe(expected);
      expect(info?.message).not.toContain("layoffs");
      expect(info?.message).toMatch(/Calendar|calendar/);
    }
  });

  it("cuts a large page into chunks of 500; every chunk carries the expected cursor, only the last the new cursor and the completion flag", async () => {
    const { calls, clientFor } = fake({ data: { removed: 0, written: 500, skipped: 0 } });
    const ups = Array.from({ length: 1200 }, (_v, i) => event(`e${String(i)}`));
    const counts = await createCalendarIndexStore(clientFor).applyPage("PKG", conn, page({ upserts: ups, removals: [] }), { expected: { value: "g1.x.c:0" }, complete: true });
    expect(calls.map((c) => (c.args.p_upserts as unknown[]).length)).toEqual([500, 500, 200]);
    expect(calls.map((c) => c.args.p_cursor)).toEqual([null, null, "g1.x.c:1"]);
    expect(calls.map((c) => c.args.p_complete)).toEqual([false, false, true]);
    expect(calls.every((c) => c.args.p_expected_cursor === "g1.x.c:0")).toBe(true);
    expect(counts.written).toBe(1500);
  });

  it("a cursor conflict is an outcome, not an error: the run stops and later chunks are not sent", async () => {
    const { calls, clientFor } = fake({ error: { code: "D0409" } });
    const ups = Array.from({ length: 600 }, (_v, i) => event(`e${String(i)}`));
    const counts = await createCalendarIndexStore(clientFor).applyPage("PKG", conn, page({ upserts: ups }), NONE);
    expect(counts.conflict).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("an unreachable lane client is connection_unavailable", async () => {
    const info = await kind(createCalendarIndexStore(async () => Promise.reject(new Error("no lane")) as never).applyPage("PKG", conn, page(), NONE));
    expect(info?.kind).toBe("connection_unavailable");
  });
});

describe("cursors", () => {
  it("use the 'calendar' stream", async () => {
    const a = fake({ data: "g1.x.c:9" });
    expect(await createCalendarIndexStore(a.clientFor).getCursor("PKG", conn)).toEqual({ value: "g1.x.c:9" });
    expect(a.calls[0]).toEqual({ fn: "sync_cursor_get", args: { p_lane: "PKG", p_connection_id: row.id, p_stream: "calendar" } });
    expect(await createCalendarIndexStore(fake({ data: null }).clientFor).getCursor("PKG", conn)).toBeNull();
    const b = fake({ data: true });
    await createCalendarIndexStore(b.clientFor).resetCursor("PKG", conn);
    expect(b.calls[0]).toEqual({ fn: "sync_cursor_reset", args: { p_lane: "PKG", p_connection_id: row.id, p_stream: "calendar" } });
  });
});
