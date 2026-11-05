// Persistence of Google Calendar sync pages (T-064) over core.cal_events_apply_page / sync_cursor_get / sync_cursor_reset.
// Same shape as the mail store (T-063): lane-aware client from the lane router, the connection must be lane-bound, the
// database checks lane, provider and status again, a page is applied atomically in chunks of 500 with the cursor on the
// last chunk, and EVERY chunk is compared with the stored cursor under the connection's lock (D0409 = conflict).
// Metadata only: each record is re-validated against the strict schema, which has no description field (rule 6).
// Never log a record or put one in an error.
import type { LaneId } from "@nichols/core";
import { EventMetaSchema, EventRemovalSchema, type CalendarSyncResult, type CommsCursor } from "../comms/schemas";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import type { JobClientFor } from "../vault/tokens";
import { APPLY_CHUNK, APPLY_MAX, createIndexRpc, type ApplyCounts } from "./index-rpc";

export const CALENDAR_STREAM = "calendar";

export interface CalendarIndexStore {
  /** The stored cursor of the connection's calendar stream, or null (first load). */
  getCursor(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<CommsCursor | null>;
  /** Discards the stored cursor (a full resync starts from nothing). */
  resetCursor(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<void>;
  /**
   * Applies one sync page and stores `page.nextCursor` with its last chunk. `expected` is the cursor the run read before
   * the page (null = none): the database compares it with the stored one under a per-connection lock on every chunk and
   * answers `conflict` when another run got there first. `complete` (the run reached its end) stamps last_sync_at.
   * A page with `fullResyncRequired` is not applicable.
   */
  applyPage(laneId: LaneId, conn: LaneBoundConnection<string>, page: CalendarSyncResult, options: { expected: CommsCursor | null; complete?: boolean }): Promise<ApplyCounts>;
}

export function createCalendarIndexStore(clientFor: JobClientFor): CalendarIndexStore {
  const call = createIndexRpc(clientFor, "Calendar");

  return {
    async getCursor(laneId, conn) {
      assertLaneBound(laneId, conn);
      const data = await call(laneId, "sync_cursor_get", { p_lane: laneId, p_connection_id: conn.id, p_stream: CALENDAR_STREAM });
      return typeof data === "string" && data.length > 0 ? { value: data } : null;
    },
    async resetCursor(laneId, conn) {
      assertLaneBound(laneId, conn);
      await call(laneId, "sync_cursor_reset", { p_lane: laneId, p_connection_id: conn.id, p_stream: CALENDAR_STREAM });
    },
    async applyPage(laneId, conn, page, options) {
      assertLaneBound(laneId, conn);
      if (page.fullResyncRequired || page.nextCursor === null) throw new ConnectorError({ kind: "invalid_input", message: "A resync answer is not a page" });
      if (page.upserts.length > APPLY_MAX || page.removals.length > APPLY_MAX) throw new ConnectorError({ kind: "invalid_input", message: "A calendar sync page is too large" });
      // Re-validate: the store is the last gate before the table (strict objects: no description or body field).
      const upserts = page.upserts.map((e) => EventMetaSchema.parse(e));
      const removals = page.removals.map((r) => EventRemovalSchema.parse(r));
      // Calendars that left the selection: their rows go with the FIRST chunk (the database deletes only this lane's rows of this connection).
      const drop = (page.dropCalendars ?? []).slice(0, 10);
      const chunks = Math.max(1, Math.ceil(upserts.length / APPLY_CHUNK), Math.ceil(removals.length / APPLY_CHUNK));
      const total: ApplyCounts = { removed: 0, written: 0, skipped: 0, conflict: false };
      for (let k = 0; k < chunks; k++) {
        const last = k === chunks - 1;
        const data = await call(laneId, "cal_events_apply_page", {
          p_lane: laneId,
          p_connection_id: conn.id,
          p_removals: removals.slice(k * APPLY_CHUNK, (k + 1) * APPLY_CHUNK),
          p_upserts: upserts.slice(k * APPLY_CHUNK, (k + 1) * APPLY_CHUNK),
          p_expected_cursor: options.expected?.value ?? null,
          // Every chunk is checked against p_expected_cursor; only the last chunk stores the new cursor.
          p_cursor: last ? page.nextCursor.value : null,
          p_complete: last && options.complete === true,
          p_drop_calendars: k === 0 ? drop : [],
        });
        if (data === "conflict") return { ...total, conflict: true };
        const counts = data as Partial<ApplyCounts> | null;
        total.removed += counts?.removed ?? 0;
        total.written += counts?.written ?? 0;
        total.skipped += counts?.skipped ?? 0;
      }
      return total;
    },
  };
}
