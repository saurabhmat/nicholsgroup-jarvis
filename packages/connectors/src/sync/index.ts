// conn.sync wired over the real stores (T-038). Server-only. Not exported from the package root; the Inngest route
// imports `connSyncJob` from "@nichols/connectors/sync". Providers join `runners` as their sync lands (QuickBooks
// T-051 is in; Stripe, GoHighLevel...); a provider without a runner fails its runs with unsupported_op.
import type { LaneId } from "@nichols/core";
import { calSync, mailSync } from "../google/index";
import { quickbooksConnector } from "../quickbooks/index";
import { connectionLoader, rawRecords, syncCursorStore, syncRunStore, syncTargetLister } from "../vault/index";
import { createConnSyncJob } from "./job";
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

export { SYNC_TRIGGERS } from "./types";
export type { ConnSyncOutcome, SyncTrigger } from "./types";

/** Ids of a lane's usable calendar-capable connections, for the scheduled cal.ingest_delta fan-out (T-130). */
export const listCalendarConnectionIds = (laneId: LaneId) => syncTargetLister.listCalendarConnectionIds(laneId);
export { CALENDAR_PROVIDERS } from "./targets";
