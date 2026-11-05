// conn.sync wired over the real stores (T-038). Server-only. Not exported from the package root; the Inngest route
// imports `connSyncJob` from "@nichols/connectors/sync". Providers join `runners` as their sync lands (QuickBooks
// T-051, Stripe, GoHighLevel...); a provider without a runner fails its runs with unsupported_op.
import { calSync, mailSync } from "../google/index";
import { connectionLoader, syncRunStore } from "../vault/index";
import { createConnSyncJob } from "./job";
import { createGoogleSyncRunner } from "./runners";

export const connSyncJob = createConnSyncJob({
  loader: connectionLoader,
  runs: syncRunStore,
  runners: { google: createGoogleSyncRunner({ mail: mailSync, calendar: calSync }) },
});

export { SYNC_TRIGGERS } from "./types";
export type { ConnSyncOutcome, SyncTrigger } from "./types";
