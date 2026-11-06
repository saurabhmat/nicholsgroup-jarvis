// Inngest endpoint (T-037): Inngest calls this route to run the app's functions. Signed requests only, except with
// the local Inngest dev server (APP_ENV=local); 503 when jobs are not configured (see @nichols/core/inngest).
// conn.sync (T-038), token health (T-040), cal.ingest_delta (T-130), fin.qbo_reports (T-052) and retention.purge (T-042) are wired here: core cannot import connectors, so the route hands the connector job to the function.
import {
  calIngestFunction,
  connHealthFunctions,
  connSyncFunction,
  finQboReportsFunctions,
  inngestRoute,
  platformFunctions,
  retentionPurgeFunctions,
} from "@nichols/core/inngest";
import { getServerEnv } from "@nichols/core/env/server";
import { connSyncJob, listCalendarConnectionIds } from "@nichols/connectors/sync";
import { listHealthConnectionIds, listRenewConnectionIds, subscriptionRenewJob, tokenHealthJob } from "@nichols/connectors/health";
import { retentionPurgeJob } from "@nichols/connectors/retention";
import { listQuickbooksConnectionIds, qboReportsJob } from "@nichols/connectors/reports";

export const { GET, POST, PUT } = inngestRoute((inngest) => [
  ...platformFunctions(inngest),
  connSyncFunction(inngest, {
    runSync: (laneId, connectionId, input) => connSyncJob.run(laneId, connectionId, input),
    enabledLanes: () => getServerEnv().ENABLED_LANES,
  }),
  // conn.token_health and conn.subscriptions_renew (T-040): daily cron scans fan out per lane and connection.
  ...connHealthFunctions(
    inngest,
    {
      enabledLanes: () => getServerEnv().ENABLED_LANES,
      listConnectionIds: (laneId) => listHealthConnectionIds(laneId),
      check: (laneId, connectionId) => tokenHealthJob.run(laneId, connectionId),
    },
    {
      enabledLanes: () => getServerEnv().ENABLED_LANES,
      listConnectionIds: (laneId) => listRenewConnectionIds(laneId),
      renew: (laneId, connectionId) => subscriptionRenewJob.run(laneId, connectionId),
    },
  ),
  // cal.ingest_delta (T-130): every 15 minutes, asks conn.sync to run each lane's usable calendar-capable connections.
  calIngestFunction(inngest, {
    listConnections: (laneId) => listCalendarConnectionIds(laneId),
    enabledLanes: () => getServerEnv().ENABLED_LANES,
  }),
  // fin.qbo_reports (T-052): nightly QuickBooks report pull into fin.report_cache, per usable QuickBooks connection.
  ...finQboReportsFunctions(inngest, {
    runReports: (laneId, connectionId) => qboReportsJob.run(laneId, connectionId),
    listConnections: (laneId) => listQuickbooksConnectionIds(laneId),
    enabledLanes: () => getServerEnv().ENABLED_LANES,
  }),
  // retention.purge (T-042): daily schedule + per-lane worker over the connectors' registry of purge functions.
  ...retentionPurgeFunctions(inngest, {
    purgeLane: (laneId) => retentionPurgeJob.run(laneId),
    enabledLanes: () => getServerEnv().ENABLED_LANES,
  }),
]);
