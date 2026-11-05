// Inngest endpoint (T-037): Inngest calls this route to run the app's functions. Signed requests only, except with
// the local Inngest dev server (APP_ENV=local); 503 when jobs are not configured (see @nichols/core/inngest).
// conn.sync (T-038), cal.ingest_delta (T-130) and retention.purge (T-042) are wired here: core cannot import connectors, so the route hands the connector job to the function.
import { calIngestFunction, connSyncFunction, inngestRoute, platformFunctions, retentionPurgeFunctions } from "@nichols/core/inngest";
import { getServerEnv } from "@nichols/core/env/server";
import { connSyncJob, listCalendarConnectionIds } from "@nichols/connectors/sync";
import { retentionPurgeJob } from "@nichols/connectors/retention";

export const { GET, POST, PUT } = inngestRoute((inngest) => [
  ...platformFunctions(inngest),
  connSyncFunction(inngest, {
    runSync: (laneId, connectionId, input) => connSyncJob.run(laneId, connectionId, input),
    enabledLanes: () => getServerEnv().ENABLED_LANES,
  }),
  // cal.ingest_delta (T-130): every 15 minutes, asks conn.sync to run each lane's usable calendar-capable connections.
  calIngestFunction(inngest, {
    listConnections: (laneId) => listCalendarConnectionIds(laneId),
    enabledLanes: () => getServerEnv().ENABLED_LANES,
  }),
  // retention.purge (T-042): daily schedule + per-lane worker over the connectors' registry of purge functions.
  ...retentionPurgeFunctions(inngest, {
    purgeLane: (laneId) => retentionPurgeJob.run(laneId),
    enabledLanes: () => getServerEnv().ENABLED_LANES,
  }),
]);
