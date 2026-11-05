// conn.sync wired over the real stores (T-038). Server-only. Not exported from the package root; the Inngest route
// imports `connSyncJob` from "@nichols/connectors/sync". Providers join `runners` as their sync lands (QuickBooks
// T-051, Stripe, GoHighLevel...); a provider without a runner fails its runs with unsupported_op.
import type { LaneId } from "@nichols/core";
import { calSync, mailSync } from "../google/index";
import { connectionLoader, syncRunStore, syncTargetLister } from "../vault/index";
import { createConnSyncJob } from "./job";
import { createGoogleSyncRunner } from "./runners";

export const connSyncJob = createConnSyncJob({
  loader: connectionLoader,
  runs: syncRunStore,
  runners: { google: createGoogleSyncRunner({ mail: mailSync, calendar: calSync }) },
});

export { SYNC_TRIGGERS } from "./types";
export type { ConnSyncOutcome, SyncTrigger } from "./types";

/** Ids of a lane's usable calendar-capable connections, for the scheduled cal.ingest_delta fan-out (T-130). */
export const listCalendarConnectionIds = (laneId: LaneId) => syncTargetLister.listCalendarConnectionIds(laneId);
export { CALENDAR_PROVIDERS } from "./targets";
