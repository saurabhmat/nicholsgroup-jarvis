import "server-only";
// fin.qbo_normalize (T-056): raw.source_records -> fin.* for one QuickBooks connection, started by the route after a
// successful QuickBooks conn.sync (event fin/qbo-normalize.requested). The work itself (connector job, one SQL function) is
// injected as `runNormalize` (apps/web wires @nichols/connectors/normalize; core cannot import connectors).
//   - Concurrency key = connection id, limit 1 (the database also serialises per connection). Retries with backoff for
//     transient failures (honouring a retry-after); a refused value or an unusable connection stops at once.
//   - Idempotent: a repeated event (the same sync twice, a manual run) changes nothing. The deterministic event id
//     `fin-normalize:<connection>:<sync run>` makes Inngest drop a duplicate of the same sync.
// Events carry ids only; the lane must be one this deployment serves, checked again on receipt.
import { NonRetriableError, RetryAfterError, type Inngest, type InngestFunction } from "inngest";
import { finQboNormalizeRequested } from "./events";

/** Mirrors QboNormalizeOutcome in @nichols/connectors/normalize (structural: core does not import connectors). */
export type FinQboNormalizeResult =
  | { ok: true; skipped: null; classFallback: boolean; written: number; tombstoned: number; unmappedRows: number; reallocated: number }
  | { ok: true; skipped: "connection_not_usable" }
  | { ok: false; retryable: boolean; retryAfterSeconds: number | null; errorKind: string; message: string };

export type FinQboNormalizeDeps = {
  runNormalize: (laneId: string, connectionId: string) => Promise<FinQboNormalizeResult>;
  enabledLanes: () => readonly string[];
};

/** Function options, exported so tests assert them. */
export const FIN_NORMALIZE_RETRIES = 3;
export const FIN_NORMALIZE_CONCURRENCY = { key: "event.data.connectionId", limit: 1 } as const;
const MAX_RETRY_AFTER_SECONDS = 15 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Whether a sync that ran should start the normalizer (T-090 cost note from T-056: every sync used to re-normalize in full).
 * With a 4-hourly backup poll most runs write nothing, so a scheduled incremental run that wrote nothing is skipped. Everything
 * else normalizes: a full run, a run that wrote, a webhook/manual/connect run. The "pick up a mapping change or an earlier
 * failed follow-up" property is kept by a daily normalize that fin.sync sends at 00:00 UTC (fin-sync.ts), decided from the
 * scheduled hour, not the clock. So a failed follow-up followed by empty polls is repaired within a day.
 */
export function shouldNormalizeAfterSync(run: { trigger: string; kind: string; written: number }): boolean {
  return run.trigger !== "schedule" || run.kind !== "incremental" || run.written > 0;
}

/** Deterministic Inngest event id for one connection after one sync run. */
export function finNormalizeEventId(connectionId: string, syncRunId: string): string {
  if (!UUID.test(connectionId) || !RUN_ID.test(syncRunId)) throw new Error("fin.qbo_normalize: invalid event id parts");
  return `fin-normalize:${connectionId}:${syncRunId}`;
}

/** The function body without Inngest, for tests: throws what Inngest needs to decide about a retry. */
export async function handleFinNormalize(
  deps: FinQboNormalizeDeps,
  data: { laneId: string; connectionId: string; trigger: string },
): Promise<Exclude<FinQboNormalizeResult, { ok: false }> | { ok: true; skipped: "lane_not_served" }> {
  // Events can reach Inngest without passing sendLaneEvent: validate again, echo nothing.
  const parsed = await finQboNormalizeRequested.schema["~standard"].validate(data);
  if (parsed.issues) throw new NonRetriableError("fin.qbo_normalize: invalid event data");
  if (!deps.enabledLanes().includes(data.laneId)) return { ok: true, skipped: "lane_not_served" };
  const result = await deps.runNormalize(data.laneId, data.connectionId);
  if (result.ok) return result;
  // Messages are already redacted (ConnectorError); they carry no record content.
  if (!result.retryable) throw new NonRetriableError(`fin.qbo_normalize failed: ${result.errorKind}`);
  if (result.retryAfterSeconds !== null && result.retryAfterSeconds > 0) {
    throw new RetryAfterError(`fin.qbo_normalize failed: ${result.errorKind}`, Math.min(result.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS) * 1000);
  }
  throw new Error(`fin.qbo_normalize failed: ${result.errorKind}`);
}

export function finQboNormalizeFunctions(inngest: Inngest, deps: FinQboNormalizeDeps): InngestFunction.Any[] {
  const worker = inngest.createFunction(
    { id: "fin-qbo-normalize-connection", triggers: [finQboNormalizeRequested], retries: FIN_NORMALIZE_RETRIES, concurrency: FIN_NORMALIZE_CONCURRENCY },
    async ({ event }) => handleFinNormalize(deps, event.data),
  );
  return [worker];
}
