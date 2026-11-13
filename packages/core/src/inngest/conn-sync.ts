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
export type SyncStreamName = "mail" | "calendar";

/** Mirrors ConnSyncOutcome in @nichols/connectors/sync (structural: core does not import connectors). */
export type ConnSyncResult =
  | { ok: true; skipped: null; runId: string; provider?: string; kind: "full" | "incremental"; received: number; written: number }
  | { ok: true; skipped: "already_running" | "connection_not_usable" }
  | { ok: false; retryable: boolean; retryAfterSeconds: number | null; errorKind: string; message: string };

export type ConnSyncDeps = {
  runSync: (laneId: string, connectionId: string, input: { trigger: SyncTriggerName; jobRunId: string | null; objectTypes?: readonly string[]; streams?: readonly SyncStreamName[] }) => Promise<ConnSyncResult>;
  enabledLanes: () => readonly string[];
  /**
   * Called after every sync that ran and was logged, whether or not it wrote anything (not for a skipped or failed one), with ids
   * only. Normalizing again is idempotent and picks up a mapping change or an earlier failed follow-up. The route uses it to
   * start the QuickBooks normalizer (fin.qbo_normalize, T-056). Its failure never fails or repeats the sync (that would redo
   * the work): the result says `followUp: "failed"` and the next sync starts it again.
   */
  afterSync?: (run: { laneId: string; connectionId: string; provider: string; runId: string; trigger: SyncTriggerName; kind: "full" | "incremental"; written: number; streams?: readonly SyncStreamName[] }) => Promise<void>;
};

/** Function options, exported so tests assert them. */
export const CONN_SYNC_RETRIES = 4;
export const CONN_SYNC_CONCURRENCY = { key: "event.data.connectionId", limit: 1 } as const;
const MAX_RETRY_AFTER_SECONDS = 15 * 60;

/** The function body without Inngest, for tests: throws what Inngest needs to decide about a retry. */
export async function handleConnSync(
  deps: ConnSyncDeps,
  data: { laneId: string; connectionId: string; trigger: SyncTriggerName; objectTypes?: readonly string[] | undefined; streams?: readonly SyncStreamName[] | undefined },
  runId: string | null,
): Promise<(Exclude<ConnSyncResult, { ok: false }> & { followUp?: "sent" | "failed" }) | { ok: true; skipped: "lane_not_served" }> {
  // Events can reach Inngest without passing sendLaneEvent (anyone holding the event key): validate again, echo nothing.
  const parsed = await connSyncRequested.schema["~standard"].validate(data);
  if (parsed.issues) throw new NonRetriableError("conn.sync: invalid event data");
  if (!deps.enabledLanes().includes(data.laneId)) return { ok: true, skipped: "lane_not_served" };
  const result = await deps.runSync(data.laneId, data.connectionId, { trigger: data.trigger, jobRunId: runId, ...(data.objectTypes ? { objectTypes: data.objectTypes } : {}), ...(data.streams ? { streams: data.streams } : {}) });
  if (result.ok) {
    if (result.skipped === null && deps.afterSync && typeof result.provider === "string") {
      try {
        await deps.afterSync({ laneId: data.laneId, connectionId: data.connectionId, provider: result.provider, runId: result.runId, trigger: data.trigger, kind: result.kind, written: result.written, ...(data.streams ? { streams: data.streams } : {}) });
        return { ...result, followUp: "sent" };
      } catch {
        return { ...result, followUp: "failed" };
      }
    }
    return result;
  }
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
