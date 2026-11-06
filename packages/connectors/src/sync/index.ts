// conn.sync wired over the real stores (T-038). Server-only. Not exported from the package root; the Inngest route
// imports `connSyncJob` from "@nichols/connectors/sync". Providers join `runners` as their sync lands (QuickBooks
// T-051 is in; Stripe, GoHighLevel...); a provider without a runner fails its runs with unsupported_op.
import type { LaneId } from "@nichols/core";
import { calSync, mailSync } from "../google/index";
import { quickbooksConnector } from "../quickbooks/index";
import { connectionLoader, laneConfigReader, rawRecords, syncCursorStore, syncRunStore, syncTargetLister } from "../vault/index";
import { createConnSyncJob } from "./job";
import { createQuickbooksUsableCheck } from "./usable";
import { createConnectorSyncRunner, createGoogleSyncRunner } from "./runners";

export const connSyncJob = createConnSyncJob({
  loader: connectionLoader,
  runs: syncRunStore,
  runners: {
    google: createGoogleSyncRunner({ mail: mailSync, calendar: calSync }),
    // QuickBooks (T-051): Connector.sync through the generic cursor (stream 'default' = the CDC changedSince instant).
    quickbooks: createConnectorSyncRunner({ connector: quickbooksConnector, cursors: syncCursorStore, sinkFor: rawRecords.sinkFor }),
  },
});

/** Whether a QuickBooks connection of the lane can be synced now (see ./usable.ts). Used by the webhook follow-up (T-053). */
export const isQuickbooksConnectionUsable = createQuickbooksUsableCheck(connectionLoader);

export { SYNC_TRIGGERS } from "./types";
export type { ConnSyncOutcome, SyncTrigger } from "./types";

/** Ids of a lane's usable calendar-capable connections, for the scheduled cal.ingest_delta fan-out (T-130). */
export const listCalendarConnectionIds = (laneId: LaneId) => syncTargetLister.listCalendarConnectionIds(laneId);
export { QBO_SYNC_ENTITIES } from "../quickbooks/entities";
export { CALENDAR_PROVIDERS } from "./targets";

/** Ids of a lane's usable QuickBooks connections for the scheduled backup poll (T-090); same list as the nightly report pull. */
export const listQuickbooksSyncConnectionIds = (laneId: LaneId) => syncTargetLister.listQuickbooksConnectionIds(laneId);
/** Hours between a lane's QuickBooks backup polls, from lane_config (default 4); throws when the setting is malformed. */
export const qboSyncIntervalHours = (laneId: LaneId) => laneConfigReader.qboSyncIntervalHours(laneId);
