// The Gmail metadata sync run (T-063): read the stored cursor, pull pages from the provider, apply each page atomically
// with its cursor, and continue until the run ends. A provider failure never advances the cursor (the stored one is
// only replaced by `applyPage`, in the same transaction as the page). An expired or foreign cursor discards the stored
// one and starts a full load. This function is what the sync job calls: the Inngest wiring comes with the connector
// sync job (T-038 / T-065 push); polling schedules call it per connection.
import type { LaneId } from "@nichols/core";
import type { MailProvider } from "../comms/provider";
import type { CommsCursor } from "../comms/schemas";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { MailIndexStore } from "./mail-store";

export type MailSyncRunResult = {
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

export type MailSyncDeps = {
  mail: MailProvider<"google">;
  store: MailIndexStore;
  logger?: ConnectorLogger;
  /** Safety cap on pages in one run. Default 500 (50,000 messages at the default page size). */
  maxPages?: number;
  pageSize?: number;
};

export function createMailSync(deps: MailSyncDeps) {
  const log = deps.logger ?? connectorLog;
  const maxPages = deps.maxPages ?? 500;

  return {
    async run(laneId: LaneId, conn: LaneBoundConnection<"google">): Promise<MailSyncRunResult> {
      assertLaneBound(laneId, conn);
      const child = log.child({ laneId, provider: "google", connectionId: conn.id });
      const options = deps.pageSize ? { pageSize: deps.pageSize } : undefined;
      const result: MailSyncRunResult = { mode: "incremental", pages: 0, written: 0, skipped: 0, removed: 0, resynced: false, conflict: false };
      let cursor: CommsCursor | null = await deps.store.getCursor(laneId, conn);
      if (cursor === null) result.mode = "full";

      for (let page = 0; page < maxPages; page++) {
        const r = await deps.mail.sync(laneId, conn, cursor, options);
        if (r.fullResyncRequired) {
          // At most one reload per run, and never for a full load: either would loop.
          if (cursor === null || result.resynced) throw new ConnectorError({ kind: "provider_error", message: "The provider asked for a second resync in one run" });
          child.warn("google.mail.full_resync", {});
          await deps.store.resetCursor(laneId, conn);
          result.mode = "full";
          result.resynced = true;
          cursor = null;
          continue;
        }
        // `cursor` is what this run read (null for a first load): the database applies the page only if it is still the
        // stored one. Pages of this run are fresh by that check, so they may bring back a message flagged deleted.
        const counts = await deps.store.applyPage(laneId, conn, r, { expected: cursor, complete: !r.hasMore, revive: true });
        if (counts.conflict) {
          child.warn("google.mail.sync_conflict", {});
          result.conflict = true;
          return result;
        }
        result.pages += 1;
        result.written += counts.written;
        result.skipped += counts.skipped;
        result.removed += counts.removed;
        cursor = r.nextCursor;
        if (!r.hasMore) {
          child.info("google.mail.sync_done", { mode: result.mode, pages: result.pages, written: result.written, removed: result.removed });
          return result;
        }
      }
      // Cap reached: the cursor of the last applied page is stored, so the next run continues from it.
      child.warn("google.mail.sync_page_cap", { pages: result.pages });
      return result;
    },
  };
}
