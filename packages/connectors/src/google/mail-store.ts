// Persistence of Gmail metadata sync pages (T-063) over core.comms_mail_apply_page / sync_cursor_get / sync_cursor_reset.
// Lane-aware: the client comes from the lane router's job client for the lane, the connection must be lane-bound for
// it, and the database checks the lane, provider and status again. A page is applied atomically (removals, then
// upserts, then the cursor, one transaction); metadata only: a record is re-validated against the strict schema and
// the call has no field that could carry a body. Never log a record or put one in an error.
import type { LaneId } from "@nichols/core";
import { MessageMetaSchema, MessageRemovalSchema, type CommsCursor, type MailSyncResult } from "../comms/schemas";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import type { JobClientFor } from "../vault/tokens";
import { APPLY_CHUNK, APPLY_MAX, createIndexRpc, type ApplyCounts } from "./index-rpc";

export const MAIL_STREAM = "mail";
export { APPLY_CHUNK, APPLY_MAX };
export type { ApplyCounts };

export interface MailIndexStore {
  /** The stored cursor of the connection's mail stream, or null (first load). */
  getCursor(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<CommsCursor | null>;
  /** Discards the stored cursor (a full resync starts from nothing). */
  resetCursor(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<void>;
  /**
   * Applies one sync page and stores `page.nextCursor` with its last chunk (chunks of 500, cursor only on the last, so a
   * poison chunk never advances it). `expected` is the cursor the run read before the page (null = none): the database
   * compares it with the stored one under a per-connection lock and answers `conflict` when another run got there first.
   * `complete` (the run reached its end) stamps the connection's last_sync_at. `revive` lets the page clear `deleted`
   * (fresh pages only). A page with `fullResyncRequired` is not applicable.
   */
  applyPage(
    laneId: LaneId,
    conn: LaneBoundConnection<string>,
    page: MailSyncResult,
    options: { expected: CommsCursor | null; complete?: boolean; revive?: boolean },
  ): Promise<ApplyCounts>;
}

export function createMailIndexStore(clientFor: JobClientFor): MailIndexStore {
  const call = createIndexRpc(clientFor, "Mail");

  return {
    async getCursor(laneId, conn) {
      assertLaneBound(laneId, conn);
      const data = await call(laneId, "sync_cursor_get", { p_lane: laneId, p_connection_id: conn.id, p_stream: MAIL_STREAM });
      return typeof data === "string" && data.length > 0 ? { value: data } : null;
    },
    async resetCursor(laneId, conn) {
      assertLaneBound(laneId, conn);
      await call(laneId, "sync_cursor_reset", { p_lane: laneId, p_connection_id: conn.id, p_stream: MAIL_STREAM });
    },
    async applyPage(laneId, conn, page, options) {
      assertLaneBound(laneId, conn);
      if (page.fullResyncRequired || page.nextCursor === null) throw new ConnectorError({ kind: "invalid_input", message: "A resync answer is not a page" });
      if (page.upserts.length > APPLY_MAX || page.removals.length > APPLY_MAX) throw new ConnectorError({ kind: "invalid_input", message: "A mail sync page is too large" });
      // Re-validate: the store is the last gate before the table (strict objects: no body, snippet or preview field).
      const upserts = page.upserts.map((m) => MessageMetaSchema.parse(m));
      const removals = page.removals.map((r) => MessageRemovalSchema.parse(r).message_id);
      const chunks = Math.max(1, Math.ceil(upserts.length / APPLY_CHUNK), Math.ceil(removals.length / APPLY_CHUNK));
      const total: ApplyCounts = { removed: 0, written: 0, skipped: 0, conflict: false };
      for (let k = 0; k < chunks; k++) {
        const last = k === chunks - 1;
        const data = await call(laneId, "comms_mail_apply_page", {
          p_lane: laneId,
          p_connection_id: conn.id,
          p_removals: removals.slice(k * APPLY_CHUNK, (k + 1) * APPLY_CHUNK),
          p_upserts: upserts.slice(k * APPLY_CHUNK, (k + 1) * APPLY_CHUNK),
          p_expected_cursor: options.expected?.value ?? null,
          // Every chunk is checked against p_expected_cursor; only the last chunk stores the new cursor.
          p_cursor: last ? page.nextCursor.value : null,
          p_complete: last && options.complete === true,
          p_revive: options.revive === true,
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
