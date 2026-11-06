// Inngest endpoint (T-037): Inngest calls this route to run the app's functions. Signed requests only, except with
// the local Inngest dev server (APP_ENV=local); 503 when jobs are not configured (see @nichols/core/inngest).
// conn.sync (T-038), token health (T-040), cal.ingest_delta (T-130), fin.qbo_reports (T-052), fin.qbo_normalize (T-056) and retention.purge (T-042) are wired here: core cannot import connectors, so the route hands the connector job to the function.
import {
  calIngestFunction,
  connHealthFunctions,
  connSyncFunction,
  finQboNormalizeFunctions,
  finQboNormalizeRequested,
  finNormalizeEventId,
  finQboReportsFunctions,
  inngestRoute,
  platformFunctions,
  qboWebhookSyncFunctions,
  retentionPurgeFunctions,
  sendLaneEvent,
} from "@nichols/core/inngest";
import type { LaneId } from "@nichols/core";
import { getServerEnv } from "@nichols/core/env/server";
import { QBO_SYNC_ENTITIES, connSyncJob, isQuickbooksConnectionUsable, listCalendarConnectionIds } from "@nichols/connectors/sync";
import { listHealthConnectionIds, listRenewConnectionIds, subscriptionRenewJob, tokenHealthJob } from "@nichols/connectors/health";
import { retentionPurgeJob } from "@nichols/connectors/retention";
import { listQuickbooksConnectionIds, qboReportsJob } from "@nichols/connectors/reports";
import { qboNormalizeJob } from "@nichols/connectors/normalize";

export const { GET, POST, PUT } = inngestRoute((inngest) => [
  ...platformFunctions(inngest),
  connSyncFunction(inngest, {
    runSync: (laneId, connectionId, input) => connSyncJob.run(laneId, connectionId, input),
    enabledLanes: () => getServerEnv().ENABLED_LANES,
    // After a QuickBooks sync that ran, normalize its raw records into fin.* (T-056). Ids only; sendLaneEvent validates the
    // event and the lane. A failure here never fails the sync (conn.sync reports followUp: "failed"; the next sync retries).
    afterSync: async ({ laneId, connectionId, provider, runId }) => {
      if (provider !== "quickbooks") return;
      await sendLaneEvent(
        finQboNormalizeRequested.create({ laneId, connectionId, trigger: "sync" }, { id: finNormalizeEventId(connectionId, runId) }),
      );
    },
  }),
  // qbo.webhook_sync (T-053): accepted QuickBooks webhook events -> one targeted conn/sync.requested per connection and batch.
  ...qboWebhookSyncFunctions(inngest, {
    isUsable: (laneId, connectionId) => isQuickbooksConnectionUsable(laneId as LaneId, connectionId),
    enabledLanes: () => getServerEnv().ENABLED_LANES,
    allowedEntities: QBO_SYNC_ENTITIES,
  }),
  // fin.qbo_normalize (T-056): raw.source_records -> fin.* for one QuickBooks connection, lane-scoped.
  ...finQboNormalizeFunctions(inngest, {
    runNormalize: (laneId, connectionId) => qboNormalizeJob.run(laneId, connectionId),
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
