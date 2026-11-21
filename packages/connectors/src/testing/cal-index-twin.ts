// In-memory twin of the calendar page writer (`core.cal_events_apply_page`, T-064, provider-generic since T-253) for the Microsoft calendar sync tests (T-067).
// It keeps the SQL's rules: the connection is usable and of provider `google` or `microsoft`; the new cursor must start with `g1.<id>.c:` (google) or
// `m1.<id>.c:` (microsoft) and be at most 16384 characters; removals first (the row stays and reads `cancelled`); a cancelled stub merges the status only
// (and inserts a stub row when nothing is stored); a normal event replaces a row only when its version is not older (strictly newer over a cancelled row);
// the cursor is stored with the page; a page applies only when the stored cursor is the expected one. pgTAP 170 / 322 pin the real function.
// Every write is recorded (`writes`), so a test can prove what reached the store and that nothing touched another connection or stream.
import { ConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import type { ApplyCounts } from "../comms/index-rpc";
import type { CalendarIndexStore } from "../comms/cal-store";
import type { CalendarSyncResult, EventMeta } from "../comms/schemas";

export type TwinEventRow = EventMeta & { connection_id: string; lane_id: string };

export function createCalendarIndexTwin(deps: { rowOf: (laneId: string, conn: { id: string }) => { provider: string; status: string; last_sync_at?: string | null } }) {
  const rows = new Map<string, TwinEventRow>();
  /** The calendar stream cursor of each connection, keyed by lane and connection (the mail stream has its own twin: a calendar apply never touches it). */
  const cursors = new Map<string, string>();
  const writes: { store: string; connectionId: string; value: unknown }[] = [];
  const stats = { applies: 0, resets: 0 };
  const rk = (laneId: string, connectionId: string, calendarId: string, eventId: string) => `${laneId}\u0000${connectionId}\u0000${calendarId}\u0000${eventId}`;
  const ck = (laneId: string, connectionId: string) => `${laneId}\u0000${connectionId}\u0000calendar`;

  const store: CalendarIndexStore = {
    async getCursor(laneId, conn) {
      assertLaneBound(laneId, conn);
      const v = cursors.get(ck(laneId, conn.id));
      return v === undefined ? null : { value: v };
    },
    async resetCursor(laneId, conn) {
      assertLaneBound(laneId, conn);
      stats.resets += 1;
      writes.push({ store: "cursors", connectionId: conn.id, value: "reset" });
      cursors.delete(ck(laneId, conn.id));
    },
    async applyPage(laneId, conn, page: CalendarSyncResult, opts): Promise<ApplyCounts> {
      assertLaneBound(laneId, conn);
      const row = deps.rowOf(laneId, conn);
      if (!["google", "microsoft"].includes(row.provider) || !["active", "degraded"].includes(row.status)) throw new ConnectorError({ kind: "forbidden", message: "Calendar index access refused" });
      if (page.nextCursor === null) throw new ConnectorError({ kind: "invalid_input", message: "A resync answer is not a page" });
      const stored = cursors.get(ck(laneId, conn.id)) ?? null;
      if (stored !== (opts.expected?.value ?? null)) return { removed: 0, written: 0, skipped: 0, conflict: true };
      const prefix = row.provider === "google" ? `g1.${conn.id}.c:` : `m1.${conn.id}.c:`;
      if (!page.nextCursor.value.startsWith(prefix) || page.nextCursor.value.length > 16_384) throw new ConnectorError({ kind: "invalid_input", message: "A calendar sync page or record was refused by the index" });
      stats.applies += 1;
      writes.push({ store: "event_index", connectionId: conn.id, value: { upserts: page.upserts, removals: page.removals } });
      writes.push({ store: "cursors", connectionId: conn.id, value: page.nextCursor.value });
      for (const k of [...rows.keys()]) {
        const e = rows.get(k);
        if (e && e.lane_id === laneId && e.connection_id === conn.id && (page.dropCalendars ?? []).includes(e.calendar_id)) rows.delete(k);
      }
      let removed = 0;
      for (const r of page.removals) {
        const hit = rows.get(rk(laneId, conn.id, r.calendar_id, r.event_id));
        if (hit && hit.status !== "cancelled") {
          hit.status = "cancelled";
          removed += 1;
        }
      }
      const last = new Map(page.upserts.map((e) => [rk(laneId, conn.id, e.calendar_id, e.event_id), e]));
      let written = 0;
      for (const [k, e] of last) {
        const hit = rows.get(k);
        if (e.status === "cancelled") {
          if (!hit) {
            rows.set(k, { ...e, connection_id: conn.id, lane_id: laneId });
            written += 1;
          } else if (e.source_updated_at === null || hit.source_updated_at === null || e.source_updated_at >= hit.source_updated_at) {
            hit.status = "cancelled";
            hit.source_updated_at = e.source_updated_at ?? hit.source_updated_at;
            written += 1;
          }
          continue;
        }
        const newer = !hit
          ? true
          : hit.status === "cancelled"
            ? e.source_updated_at !== null && (hit.source_updated_at === null || e.source_updated_at > hit.source_updated_at)
            : hit.source_updated_at === null || (e.source_updated_at !== null && e.source_updated_at >= hit.source_updated_at);
        if (!newer) continue;
        rows.set(k, { ...e, connection_id: conn.id, lane_id: laneId });
        written += 1;
      }
      cursors.set(ck(laneId, conn.id), page.nextCursor.value);
      if (opts.complete) {
        const r = deps.rowOf(laneId, conn);
        r.last_sync_at = new Date().toISOString();
      }
      return { removed, written, skipped: last.size - written, conflict: false };
    },
  };

  return {
    store,
    rows,
    cursors,
    writes,
    stats,
    cursorOf: (laneId: string, connectionId: string) => cursors.get(ck(laneId, connectionId)),
    rowsOf: (connectionId: string) => [...rows.values()].filter((r) => r.connection_id === connectionId),
    /** Test setup: rows and a cursor that exist before the code under test runs (not recorded as a write). */
    seed(laneId: string, connectionId: string, rowsIn: EventMeta[], cursor: string) {
      for (const r of rowsIn) rows.set(rk(laneId, connectionId, r.calendar_id, r.event_id), { ...r, connection_id: connectionId, lane_id: laneId });
      cursors.set(ck(laneId, connectionId), cursor);
    },
  };
}
export type CalendarIndexTwin = ReturnType<typeof createCalendarIndexTwin>;
