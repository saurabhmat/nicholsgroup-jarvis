// Inngest endpoint (T-037): Inngest calls this route to run the app's functions. Signed requests only, except with
// the local Inngest dev server (APP_ENV=local); 503 when jobs are not configured (see @nichols/core/inngest).
// conn.sync (T-038) and token health (T-040) are wired here: core cannot import connectors, so the route hands the connector job to the function.
import { connHealthFunctions, connSyncFunction, inngestRoute, platformFunctions } from "@nichols/core/inngest";
import { getServerEnv } from "@nichols/core/env/server";
import { connSyncJob } from "@nichols/connectors/sync";
import { listHealthConnectionIds, listRenewConnectionIds, subscriptionRenewJob, tokenHealthJob } from "@nichols/connectors/health";

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
]);
