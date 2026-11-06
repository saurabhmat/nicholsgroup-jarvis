import "server-only";
// conn.sync (T-038): the Inngest function that syncs one connection. The sync itself (connector, run log, cursors) is
// injected as `runSync` (apps/web wires @nichols/connectors/sync; core cannot import connectors).
//   - Concurrency: key = connection id, limit 1, so one connection never syncs twice at once while other connections
//     run in parallel. The database also allows one running sync_runs row per connection (backstop).
//   - Retries: transient failures (the connector's `retry` disposition) are retried by Inngest with backoff, honouring a
//     provider retry-after; permanent ones (reconnect_required, forbidden, ...) stop at once with NonRetriableError.
//   - Failure isolation: functions are independent runs, so one connection failing never blocks another.
// Events carry ids only; the lane must be one this deployment serves.
import { NonRetriableError, RetryAfterError, type Inngest, type InngestFunction } from "inngest";
import { connSyncRequested } from "./events";

export type SyncTriggerName = "schedule" | "manual" | "webhook" | "connect";

/** Mirrors ConnSyncOutcome in @nichols/connectors/sync (structural: core does not import connectors). */
export type ConnSyncResult =
  | { ok: true; skipped: null; runId: string; kind: "full" | "incremental"; received: number; written: number }
  | { ok: true; skipped: "already_running" | "connection_not_usable" }
  | { ok: false; retryable: boolean; retryAfterSeconds: number | null; errorKind: string; message: string };

export type ConnSyncDeps = {
  runSync: (laneId: string, connectionId: string, input: { trigger: SyncTriggerName; jobRunId: string | null }) => Promise<ConnSyncResult>;
  enabledLanes: () => readonly string[];
};

/** Function options, exported so tests assert them. */
export const CONN_SYNC_RETRIES = 4;
export const CONN_SYNC_CONCURRENCY = { key: "event.data.connectionId", limit: 1 } as const;
const MAX_RETRY_AFTER_SECONDS = 15 * 60;

/** The function body without Inngest, for tests: throws what Inngest needs to decide about a retry. */
export async function handleConnSync(
  deps: ConnSyncDeps,
  data: { laneId: string; connectionId: string; trigger: SyncTriggerName },
  runId: string | null,
): Promise<Exclude<ConnSyncResult, { ok: false }> | { ok: true; skipped: "lane_not_served" }> {
  // Events can reach Inngest without passing sendLaneEvent (anyone holding the event key): validate again, echo nothing.
  const parsed = await connSyncRequested.schema["~standard"].validate(data);
  if (parsed.issues) throw new NonRetriableError("conn.sync: invalid event data");
  if (!deps.enabledLanes().includes(data.laneId)) return { ok: true, skipped: "lane_not_served" };
  const result = await deps.runSync(data.laneId, data.connectionId, { trigger: data.trigger, jobRunId: runId });
  if (result.ok) return result;
  // Messages are already redacted (ConnectorError); they carry no tokens or record content.
  if (!result.retryable) throw new NonRetriableError(`conn.sync failed: ${result.errorKind}`);
  if (result.retryAfterSeconds !== null && result.retryAfterSeconds > 0) {
    throw new RetryAfterError(`conn.sync failed: ${result.errorKind}`, Math.min(result.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS) * 1000);
  }
  throw new Error(`conn.sync failed: ${result.errorKind}`);
}

export function connSyncFunction(inngest: Inngest, deps: ConnSyncDeps): InngestFunction.Any {
  return inngest.createFunction(
    { id: "conn-sync", triggers: [connSyncRequested], retries: CONN_SYNC_RETRIES, concurrency: CONN_SYNC_CONCURRENCY },
    async ({ event, runId }) => handleConnSync(deps, event.data, typeof runId === "string" ? runId : null),
  );
}
