import "server-only";
// Inngest client and route handlers (T-037, architecture §8). Import path: @nichols/core/inngest
// - getInngest(): the client, created on first use (restricted to this folder, lint). Keys come from
//   getInngestEnv(). Dev mode (local Inngest dev server, no request signing) needs APP_ENV=local AND a development
//   build, so a production build can never run unsigned (T-037 review L2).
// - inngestRoute(functions): GET/POST/PUT for app/api/inngest/route.ts. Not on PR Previews (unreviewed code; their
//   env refuses Inngest keys), and outside local only with keys: otherwise 503. In cloud mode, registration needs a
//   signed request and the app's URL is pinned to NEXT_PUBLIC_APP_URL (review M1).
// - sendLaneEvent(event): validates against the REGISTERED schema for the event name and refuses lanes this deployment
//   does not serve (review L1, L4). Functions validate again on receipt (eventType triggers).
// Functions take `laneId` from their event and use the lane router's job client (JOB_RUNNERS lint list).
import { Inngest, type InngestFunction } from "inngest";
import { serve } from "inngest/next";
import { getInngestEnv, getServerEnv, isDevelopmentRuntime } from "../env/server";
import { LANE_EVENTS } from "./events";

export {
  actionApproved,
  briefingRefreshRequested,
  attentionEventId,
  CONN_ATTENTION_REASONS,
  connAttentionNeeded,
  connHealthCheckRequested,
  connSubscriptionRenewRequested,
  connSyncRequested,
  finQboNormalizeRequested,
  finQboReportsRequested,
  LANE_EVENTS,
  laneIdSchema,
  retentionPurgeRequested,
  systemHeartbeat,
  webhookReceived,
} from "./events";
export { platformFunctions } from "./functions";
export { BRAIN_IMPORT_PURGE_CRON, BRAIN_IMPORT_PURGE_RETRIES, brainImportPurgeFunction, handleBrainImportPurge } from "./brain-import-purge";
export type { BrainImportPurgeDeps } from "./brain-import-purge";
export { QBO_WEBHOOK_BATCH, QBO_WEBHOOK_RETRIES, handleQboWebhookSync, qboWebhookSyncEventId, qboWebhookSyncFunctions } from "./qbo-webhook-sync";
export type { QboWebhookSyncDeps, QboWebhookSyncResult } from "./qbo-webhook-sync";
export {
  CAL_INGEST_CADENCE_MS,
  CAL_INGEST_CRON,
  CAL_INGEST_RETRIES,
  calIngestEventId,
  calIngestFunction,
  calIngestSlot,
  handleCalIngest,
  planCalIngest,
} from "./cal-ingest";
export type { CalIngestDeps, CalIngestPlan } from "./cal-ingest";
export {
  MAIL_INGEST_CADENCE_MS,
  MAIL_INGEST_CRON,
  MAIL_INGEST_RETRIES,
  briefingRefreshEventId,
  handleMailIngest,
  mailIngestEventId,
  mailIngestFunction,
  mailIngestSlot,
  shouldRefreshBriefingAfterSync,
} from "./mail-ingest";
export type { MailIngestDeps, MailIngestPlan } from "./mail-ingest";
export { FAILURE_ALERT_THRESHOLD, failureCode, withFailureTracking } from "./failure-tracking";
export type { FailureTracker } from "./failure-tracking";
export { BRIEFING_REFRESH_RETRIES, briefingRefreshFunction, handleBriefingRefresh } from "./briefing-refresh";
export type { BriefingRefreshDeps, BriefingRefreshOutcome } from "./briefing-refresh";
export {
  FIN_REPORTS_CONCURRENCY,
  FIN_REPORTS_CRON,
  FIN_REPORTS_RETRIES,
  FIN_REPORTS_SCHEDULE_RETRIES,
  finQboReportsFunctions,
  finReportsEventId,
  handleFinReports,
  handleFinReportsSchedule,
  planFinReports,
} from "./fin-reports";
export type { FinQboReportsDeps, FinQboReportsResult, FinReportsPlan } from "./fin-reports";
export {
  FIN_SYNC_CRON,
  FIN_SYNC_INTERVALS,
  FIN_SYNC_RETRIES,
  finSyncDue,
  finSyncEventId,
  finSyncFunction,
  finSyncHour,
  handleFinSync,
  planFinSync,
} from "./fin-sync";
export type { FinSyncDeps, FinSyncPlan } from "./fin-sync";
export {
  FIN_NORMALIZE_CONCURRENCY,
  FIN_NORMALIZE_RETRIES,
  finNormalizeEventId,
  shouldNormalizeAfterSync,
  finQboNormalizeFunctions,
  handleFinNormalize,
} from "./fin-normalize";
export type { FinQboNormalizeDeps, FinQboNormalizeResult } from "./fin-normalize";
export { CONN_SYNC_CONCURRENCY, CONN_SYNC_RETRIES, connSyncFunction, handleConnSync } from "./conn-sync";
export {
  RETENTION_CRON,
  RETENTION_PURGE_CONCURRENCY,
  RETENTION_PURGE_RETRIES,
  RETENTION_SCHEDULE_RETRIES,
  handleRetentionPurge,
  retentionPurgeFunctions,
} from "./retention-purge";
export type { RetentionPurgeDeps, RetentionPurgeResult } from "./retention-purge";
export type { ConnSyncDeps, ConnSyncResult } from "./conn-sync";
export {
  CONN_HEALTH_CONCURRENCY,
  CONN_HEALTH_CRON,
  CONN_HEALTH_RETRIES,
  CONN_RENEW_CONCURRENCY,
  CONN_RENEW_CRON,
  connHealthFunctions,
  handleConnHealthCheck,
  handleConnRenew,
  planFanOut,
} from "./conn-health";
export type { AttentionAlert, ConnHealthDeps, ConnHealthResult, ConnRenewDeps, ConnRenewResult } from "./conn-health";

const APP_ID = "nichols-portal";
let client: Inngest | undefined;

const isLocalDev = () => getServerEnv().APP_ENV === "local" && isDevelopmentRuntime();

export function getInngest(): Inngest {
  if (client) return client;
  const local = isLocalDev();
  const keys = getInngestEnv();
  client = new Inngest({
    id: APP_ID,
    isDev: local,
    ...(keys.configured && !local ? { eventKey: keys.INNGEST_EVENT_KEY, signingKey: keys.INNGEST_SIGNING_KEY } : {}),
  });
  return client;
}

/** Whether this deployment can serve and send Inngest jobs (local dev server, or keys configured). */
export function inngestAvailable(): boolean {
  if (getServerEnv().APP_ENV === "preview") return false;
  return isLocalDev() || getInngestEnv().configured;
}

/**
 * Validates a lane event against its schema, then sends it. Always use this instead of `getInngest().send()`, so an
 * event without a valid `laneId` (or with unknown fields) never leaves the process. `id` (optional) is Inngest's event
 * id: a second send with the same id inside Inngest's dedupe window is dropped (webhook receiver, T-036).
 */
export async function sendLaneEvent(event: { name: string; data: { laneId: string }; id?: string }) {
  const registered = LANE_EVENTS.find((e) => e.name === event.name);
  if (!registered) throw new Error("unknown event");
  const parsed = await registered.schema["~standard"].validate(event.data);
  if (parsed.issues) throw new Error("invalid event data"); // missing/invalid laneId or unknown fields; no values echoed
  if (!getServerEnv().ENABLED_LANES.includes(event.data.laneId)) throw new Error("lane not served");
  if (!inngestAvailable()) throw new Error("jobs not configured");
  return getInngest().send({ name: event.name, data: event.data, ...(event.id ? { id: event.id } : {}) });
}

type Handler = (request: Request, context: unknown) => Promise<Response>;

/** `functions` is called on the first request (no env access while the app is built). */
export function inngestRoute(
  functions: (inngest: Inngest) => readonly InngestFunction.Any[],
): { GET: Handler; POST: Handler; PUT: Handler } {
  let handlers: { GET: Handler; POST: Handler; PUT: Handler } | undefined;
  const unavailable = () =>
    Response.json({ error: "jobs_not_configured" }, { status: 503, headers: { "cache-control": "no-store" } });
  const route = (method: "GET" | "POST" | "PUT"): Handler => async (request, context) => {
    if (!inngestAvailable()) return unavailable();
    const inngest = getInngest();
    handlers ??= serve({
      client: inngest,
      functions: [...functions(inngest)],
      ...(isLocalDev() ? {} : { enableUnauthedSync: false, serveOrigin: getServerEnv().NEXT_PUBLIC_APP_URL }),
    }) as unknown as typeof handlers & object;
    return handlers[method](request, context);
  };
  return { GET: route("GET"), POST: route("POST"), PUT: route("PUT") };
}
export { BRIEFING_DAILY_CRON, BRIEFING_DAILY_RETRIES, BRIEFING_WINDOW_MINUTES, briefingDailyFunction, handleBriefingDaily, isBriefingDue } from "./briefing-daily";
export type { BriefingDailyDeps } from "./briefing-daily";
export { NEWS_DAILY_CRON, NEWS_DAILY_RETRIES, handleNewsDaily, isNewsTimeReached, newsDailyFunction } from "./news-daily";
export type { NewsDailyDeps } from "./news-daily";
export { ACTION_EXPIRE_CRON, ACTION_EXPIRE_RETRIES, actionExpireFunction, handleActionExpire } from "./action-expire";
export type { ActionExpireDeps } from "./action-expire";
export { ACTION_RECONCILE_CRON, ACTION_RECONCILE_RETRIES, actionReconcileFunction, handleActionReconcile } from "./action-reconcile";
export type { ActionReconcileDeps, ActionReconcileSummary } from "./action-reconcile";
