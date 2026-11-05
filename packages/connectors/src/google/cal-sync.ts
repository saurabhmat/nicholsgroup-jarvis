// The Google Calendar sync run (T-064), the twin of the mail run (T-063): read the stored cursor, pull pages from the
// provider, apply each page atomically with its cursor, continue until the run ends. A provider failure never advances
// the cursor (only `applyPage` replaces it, in the same transaction as the page). A refused cursor (expired syncToken,
// foreign or malformed) discards the stored one and starts a full load of every calendar. The Inngest wiring comes with
// the connector sync job; polling schedules call `run` per connection.
import type { LaneId } from "@nichols/core";
import type { CalendarProvider } from "../comms/provider";
import type { CommsCursor } from "../comms/schemas";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { CalendarIndexStore } from "./cal-store";

export type CalendarSyncRunResult = {
  mode: "full" | "incremental";
  pages: number;
  written: number;
  skipped: number;
  removed: number;
  /** True when the stored cursor was refused and the run reloaded from scratch. */
  resynced: boolean;
  /** True when another run advanced the cursor first: this run stopped without applying more (the other run's work stands). */
  conflict: boolean;
};

export type CalendarSyncDeps = {
  calendar: CalendarProvider<"google">;
  store: CalendarIndexStore;
  logger?: ConnectorLogger;
  /** Safety cap on pages in one run. Default 500. */
  maxPages?: number;
  pageSize?: number;
};

export function createCalendarSync(deps: CalendarSyncDeps) {
  const log = deps.logger ?? connectorLog;
  const maxPages = deps.maxPages ?? 500;

  return {
    async run(laneId: LaneId, conn: LaneBoundConnection<"google">): Promise<CalendarSyncRunResult> {
      assertLaneBound(laneId, conn);
      const child = log.child({ laneId, provider: "google", connectionId: conn.id });
      const options = deps.pageSize ? { pageSize: deps.pageSize } : undefined;
      const result: CalendarSyncRunResult = { mode: "incremental", pages: 0, written: 0, skipped: 0, removed: 0, resynced: false, conflict: false };
      let cursor: CommsCursor | null = await deps.store.getCursor(laneId, conn);
      if (cursor === null) result.mode = "full";

      for (let page = 0; page < maxPages; page++) {
        const r = await deps.calendar.sync(laneId, conn, cursor, options);
        if (r.fullResyncRequired) {
          // At most one reload per run, and never for a full load: either would loop.
          if (cursor === null || result.resynced) throw new ConnectorError({ kind: "provider_error", message: "The provider asked for a second resync in one run" });
          child.warn("google.calendar.full_resync", {});
          await deps.store.resetCursor(laneId, conn);
          result.mode = "full";
          result.resynced = true;
          cursor = null;
          continue;
        }
        const counts = await deps.store.applyPage(laneId, conn, r, { expected: cursor, complete: !r.hasMore });
        if (counts.conflict) {
          child.warn("google.calendar.sync_conflict", {});
          result.conflict = true;
          return result;
        }
        result.pages += 1;
        result.written += counts.written;
        result.skipped += counts.skipped;
        result.removed += counts.removed;
        cursor = r.nextCursor;
        if (!r.hasMore) {
          child.info("google.calendar.sync_done", { mode: result.mode, pages: result.pages, written: result.written, removed: result.removed });
          return result;
        }
      }
      // Cap reached: the cursor of the last applied page is stored, so the next run continues from it.
      child.warn("google.calendar.sync_page_cap", { pages: result.pages });
      return result;
    },
  };
}
