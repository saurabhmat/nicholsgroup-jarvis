// Inngest endpoint (T-037): Inngest calls this route to run the app's functions. Signed requests only, except with
// the local Inngest dev server (APP_ENV=local); 503 when jobs are not configured (see @nichols/core/inngest).
// conn.sync (T-038), token health (T-040), cal.ingest_delta (T-130), mail.ingest_delta and briefing.refresh (T-238), fin.sync QuickBooks (T-090), fin.qbo_reports (T-052), fin.qbo_normalize (T-056) and retention.purge (T-042) and brain.import_purge (T-210) are wired here: core cannot import connectors, so the route hands the connector job to the function.
import {
  actionExpireFunction,
  actionReconcileFunction,
  brainImportPurgeFunction,
  briefingDailyFunction,
  briefingRefreshEventId,
  briefingRefreshFunction,
  briefingRefreshRequested,
  calIngestFunction,
  connHealthFunctions,
  connSyncFunction,
  finQboNormalizeFunctions,
  finQboNormalizeRequested,
  finNormalizeEventId,
  finQboReportsFunctions,
  finSyncFunction,
  inngestRoute,
  mailIngestFunction,
  mailIngestSlot,
  newsDailyFunction,
  platformFunctions,
  qboWebhookSyncFunctions,
  retentionPurgeFunctions,
  sendLaneEvent,
  shouldNormalizeAfterSync,
  withFailureTracking,
  shouldRefreshBriefingAfterSync,
} from "@nichols/core/inngest";
import type { LaneId } from "@nichols/core";
import { getLaneJobClient } from "@nichols/core/lane-router";
import { BRAIN_RETENTION, createImportPurge } from "@nichols/brain/jobs";
import { getServerEnv } from "@nichols/core/env/server";
import { QBO_SYNC_ENTITIES, connSyncJob, isQuickbooksConnectionUsable, listCalendarConnectionIds, listMailConnectionIds, listQuickbooksSyncConnectionIds, qboSyncIntervalHours } from "@nichols/connectors/sync";
import { listHealthConnectionIds, listRenewConnectionIds, markReconnectNotified, subscriptionRenewJob, tokenHealthJob } from "@nichols/connectors/health";
import { retentionPurgeJob, retentionRegistry } from "@nichols/connectors/retention";
import { listQuickbooksConnectionIds, qboReportsJob } from "@nichols/connectors/reports";
import { qboNormalizeJob } from "@nichols/connectors/normalize";
import { purgeBriefingRuns, purgeBriefings, purgeNews } from "@nichols/briefing/jobs";
import { expireStaleActions, reconcileStuckLane } from "@nichols/approvals/wire";
import { createFailureTracker } from "@/lib/job-failures";
import { dueOwners, ownersWithViews, runRefresh, runScheduled } from "@/lib/briefing-schedule";
import { newsDue, runScheduledNews } from "@/lib/news-schedule";

// A scheduled news fetch (one model call with web search and up to 2 resumes, 80 s abort) runs inside this route's step.
export const maxDuration = 120;

const importPurge = createImportPurge({ clientFor: (laneId) => getLaneJobClient(laneId) });
// The brain tables in the retention catalog: kept until deleted, or cleaned by brain-import-purge (never by retention.purge).
for (const declaration of BRAIN_RETENTION) retentionRegistry.declare(declaration);
// brief.briefings (T-231c): prepared briefings follow the lane policy's retention (default 30 days, capped by SQL).
// Registered once (register throws on a duplicate id if this module is evaluated again). The job client is created here,
// the only briefing code that holds it (security review H2).
if (!retentionRegistry.list().some((t) => t.id === "brief.briefings")) {
  retentionRegistry.register({ id: "brief.briefings", class: "policy", purge: async (laneId, keepDays) => purgeBriefings(await getLaneJobClient(laneId as LaneId), laneId as LaneId, Math.min(keepDays ?? 30, 30)) });
}
// brief.briefing_runs (T-235): run claims (metadata only, about 6 rows per lane and day), kept 30 days like the briefings.
if (!retentionRegistry.list().some((t) => t.id === "brief.briefing_runs")) {
  retentionRegistry.register({ id: "brief.briefing_runs", class: "policy", purge: async (laneId, keepDays) => purgeBriefingRuns(await getLaneJobClient(laneId as LaneId), laneId as LaneId, Math.min(keepDays ?? 30, 30)) });
}
// brief.news_digests (T-234 part 4): kept 30 days by default (the SQL purge never deletes the current month, the spend ledger).
if (!retentionRegistry.list().some((t) => t.id === "brief.news_digests")) {
  retentionRegistry.register({ id: "brief.news_digests", class: "policy", purge: async (laneId, keepDays) => purgeNews(await getLaneJobClient(laneId as LaneId), laneId as LaneId, Math.min(keepDays ?? 30, 30)) });
}
const briefingClient = (laneId: string) => getLaneJobClient(laneId as LaneId);

// Failure tracking (T-238 E): every cron-triggered function below, and conn.sync runs started by the schedule, counts consecutive failures
// per lane; the third in a row raises the in-app banner and one server log line. Created per request set-up through withFailureTracking.
const failureTracker = createFailureTracker({ clientFor: briefingClient, enabledLanes: () => getServerEnv().ENABLED_LANES });

const functionsFor = (inngest: Parameters<Parameters<typeof inngestRoute>[0]>[0]) => [
  ...platformFunctions(inngest),
  connSyncFunction(inngest, {
    runSync: (laneId, connectionId, input) => connSyncJob.run(laneId, connectionId, input),
    enabledLanes: () => getServerEnv().ENABLED_LANES,
    // After a QuickBooks sync that ran, normalize its raw records into fin.* (T-056). Ids only; sendLaneEvent validates the
    // event and the lane. A failure here never fails the sync (conn.sync reports followUp: "failed"; the next sync that wrote, or the daily 00:00 UTC catch-up from fin.sync, retries).
    afterSync: async ({ laneId, connectionId, provider, runId, trigger, kind, written, streams }) => {
      // A scheduled mail sync that wrote at least one message asks for a briefing refresh (T-238): one event per lane per 15-minute
      // slot. The refresh itself goes through the run claim; its failure here never fails the sync (followUp "failed").
      if (shouldRefreshBriefingAfterSync({ provider, trigger, streams, written })) {
        await sendLaneEvent(briefingRefreshRequested.create({ laneId }, { id: briefingRefreshEventId(laneId, mailIngestSlot(Date.now())) }));
        return;
      }
      if (provider !== "quickbooks") return;
      // A scheduled backup poll that wrote nothing skips it (T-090); see shouldNormalizeAfterSync.
      if (!shouldNormalizeAfterSync({ trigger, kind, written })) return;
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
    runNormalize: (laneId, connectionId, trigger) => qboNormalizeJob.run(laneId, connectionId, { ...(trigger === "schedule" || trigger === "manual" || trigger === "webhook" || trigger === "connect" ? { trigger } : {}) }),
    enabledLanes: () => getServerEnv().ENABLED_LANES,
  }),
  // conn.token_health and conn.subscriptions_renew (T-040): daily cron scans fan out per lane and connection.
  ...connHealthFunctions(
    inngest,
    {
      enabledLanes: () => getServerEnv().ENABLED_LANES,
      listConnectionIds: (laneId) => listHealthConnectionIds(laneId),
      check: (laneId, connectionId) => tokenHealthJob.run(laneId, connectionId),
      markReconnectNotified: (laneId, connectionId) => markReconnectNotified(laneId as never, connectionId),
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
  // mail.ingest_delta (T-238): every 15 minutes (offset to :07/:22/:37/:52), asks conn.sync for the mail stream of each usable mailbox.
  mailIngestFunction(inngest, {
    listConnections: (laneId) => listMailConnectionIds(laneId),
    enabledLanes: () => getServerEnv().ENABLED_LANES,
  }),
  // briefing.refresh (T-238): after a scheduled mail sync wrote messages, each owner's briefing is refreshed through the run claim
  // (stale after 3 h, 6 a day, one running); a refusal never calls the model. Needs a sync of this function in Inngest Cloud.
  briefingRefreshFunction(inngest, {
    enabledLanes: () => getServerEnv().ENABLED_LANES,
    owners: (laneId) => ownersWithViews(briefingClient, laneId),
    refresh: (laneId, owner, now) => runRefresh(briefingClient, laneId, owner, now),
  }),
  // fin.sync QuickBooks (T-090): hourly tick; each lane's usable QuickBooks connections get a backup CDC poll every
  // lane_config.finance.qbo_sync.interval_hours (default 4) through conn.sync.
  finSyncFunction(inngest, {
    listConnections: (laneId) => listQuickbooksSyncConnectionIds(laneId),
    intervalHours: (laneId) => qboSyncIntervalHours(laneId),
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
  // briefing.daily (T-231c): hourly tick; a lane runs only when lane_config.briefing.schedule_enabled (default off) and it is
  // the lane's briefing hour in New York. Owners re-checked every run.
  briefingDailyFunction(inngest, {
    enabledLanes: () => getServerEnv().ENABLED_LANES,
    dueOwners: (laneId, now) => dueOwners(briefingClient, laneId, now),
    run: (laneId, owner, now) => runScheduled(briefingClient, laneId, owner, now),
  }),
  // news.daily (T-234 part 4): every 15 min; a lane fetches only when lane_config.news.enabled, its time (news.time, default 06:00 New
  // York) has passed today and the SQL gates agree (web category, monthly cap, retry rules: a failed or lost fetch is retried by a
  // later tick, 30 minutes apart, at most 3 failures a day, nothing after an ok digest). Needs a sync of this function in
  // Inngest Cloud after the deploy (backlog H-051).
  newsDailyFunction(inngest, {
    enabledLanes: () => getServerEnv().ENABLED_LANES,
    due: (laneId, now) => newsDue(briefingClient, laneId, now),
    run: (laneId, now) => runScheduledNews(briefingClient, laneId, now),
  }),
  // action.expire (T-232): every 15 min, stale approval actions expire and lose their composed body (D-19).
  actionExpireFunction(inngest, {
    enabledLanes: () => getServerEnv().ENABLED_LANES,
    expireLane: (laneId) => expireStaleActions(laneId as LaneId),
  }),
  // action.reconcile_stuck (T-192): every 5 min, actions stuck in `executing` are verified by the provider marker or failed as outcome_unknown. Verify-only.
  actionReconcileFunction(inngest, {
    enabledLanes: () => getServerEnv().ENABLED_LANES,
    reconcileLane: (laneId) => reconcileStuckLane(laneId as LaneId),
  }),
  // brain.import_purge (T-210): hourly, deletes brain import candidates older than 23 h and closes stale imports, per lane.
  brainImportPurgeFunction(inngest, {
    purgeLane: (laneId) => importPurge.purgeLane(laneId as LaneId),
    enabledLanes: () => getServerEnv().ENABLED_LANES,
  }),
];

export const { GET, POST, PUT } = inngestRoute((client) => functionsFor(withFailureTracking(client, failureTracker)));
