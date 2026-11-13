// Scheduled-function failures (T-238 part E), web side:
//  - createFailureTracker: what the Inngest route hands to withFailureTracking. It writes through core.job_failure_record /
//    core.job_failure_clear with the lane's job client (injected: only the route holds it). Ids, a count and a short code only.
//  - jobFailureBannerFor: the in-app banner data for owner and admin_technical at AAL2 (the read goes through the signed-in user's
//    client, so core.job_failures' RLS - the 'health' view, AAL2 - is the second guard). Nobody else gets anything.
//  - FUNCTION_NAMES: a friendly name per function id; an id this list does not know is "A scheduled job" (never the raw id).
// An email or push alert is NOT sent: no alert sender exists and external writes belong to approvals (rule 5); see Needs human in the backlog.
import { AuthError, type Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import type { FailureTracker } from "@nichols/core/inngest";
import { CONNECT_ROLES } from "@nichols/connectors/oauth";
import { easternTime, syncErrorText } from "@nichols/briefing/domain";

export const FAILURE_BANNER_THRESHOLD = 3;

export const FUNCTION_NAMES: Readonly<Record<string, string>> = {
  "conn-sync": "Mail and calendar sync",
  "conn-sync.mail": "Mail sync",
  "conn-sync.calendar": "Calendar sync",
  "mail-ingest-delta": "Mail sync schedule",
  "cal-ingest-delta": "Calendar sync schedule",
  "briefing-daily": "Daily summary",
  "news-daily": "GovCon news",
  "fin-sync-quickbooks": "QuickBooks sync",
  "fin-qbo-reports-schedule": "QuickBooks reports",
  "retention-purge-schedule": "Data cleanup",
  "action-expire": "Approval expiry",
  "action-reconcile-stuck": "Approval check",
  "brain-import-purge": "Import cleanup",
  "conn-token-health-scan": "Connection health check",
  "conn-subscriptions-renew-scan": "Subscription renewal",
};
export const functionName = (id: string): string => (Object.hasOwn(FUNCTION_NAMES, id) ? (FUNCTION_NAMES[id] as string) : "A scheduled job");

type JobClientFor = (laneId: string) => Promise<Pick<LaneClient, "schema">>;
type Rpc = { schema(s: "core"): { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> } };

export function createFailureTracker(deps: { clientFor: JobClientFor; enabledLanes: () => readonly string[] }): FailureTracker {
  const rpc = async (laneId: string, fn: string, args: Record<string, unknown>) => {
    const { data, error } = await ((await deps.clientFor(laneId)) as unknown as Rpc).schema("core").rpc(fn, args);
    if (error) throw new Error("job failure store unavailable");
    return data;
  };
  return {
    enabledLanes: deps.enabledLanes,
    async recordFailure(laneId, functionId, connectionId, code) {
      const data = await rpc(laneId, "job_failure_record", { p_lane: laneId, p_function: functionId, p_connection: connectionId, p_code: code });
      const row = (Array.isArray(data) ? data[0] : data) as { consecutive_failures?: unknown; alert?: unknown } | null | undefined;
      return { consecutive: typeof row?.consecutive_failures === "number" ? row.consecutive_failures : 0, alert: row?.alert === true };
    },
    async recordSuccess(laneId, functionId, connectionId) {
      await rpc(laneId, "job_failure_clear", { p_lane: laneId, p_function: functionId, p_connection: connectionId });
    },
  };
}

export type JobFailureItem = {
  functionId: string;
  name: string;
  failures: number;
  /** Start of the streak, ISO; null when unknown. */
  since: string | null;
  /** A fixed sentence for the last error code, or null. */
  detail: string | null;
};

const CODE = /^[a-z][a-z_]{0,40}$/;
const iso = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/** Rows of core.job_failures -> banner items. Only alerted rows with at least 3 failures; one item per function (the streak that began first). */
export function toJobFailureItems(data: unknown): JobFailureItem[] {
  if (!Array.isArray(data)) return [];
  const byFunction = new Map<string, JobFailureItem>();
  for (const raw of data as Record<string, unknown>[]) {
    if (typeof raw?.function_id !== "string" || typeof raw.consecutive_failures !== "number" || raw.consecutive_failures < FAILURE_BANNER_THRESHOLD || raw.alerted_at == null) continue;
    const code = typeof raw.last_error_code === "string" && CODE.test(raw.last_error_code) ? raw.last_error_code : null;
    const item: JobFailureItem = {
      functionId: raw.function_id,
      name: functionName(raw.function_id),
      failures: raw.consecutive_failures,
      since: iso(raw.streak_started_at),
      detail: code && code !== "failed" && code !== "lane_unavailable" ? syncErrorText(code, null) : null,
    };
    const prior = byFunction.get(item.functionId);
    if (!prior || (item.since !== null && (prior.since === null || item.since < prior.since))) byFunction.set(item.functionId, item);
  }
  return [...byFunction.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** "Mail sync has failed 3 times in a row since 9:15 AM ET." */
export function failureSentence(item: JobFailureItem, now: Date): string {
  return `${item.name} has failed ${String(item.failures)} times in a row${item.since ? ` since ${easternTime(item.since, now)}` : ""}.`;
}

/**
 * The failures to warn about, for owner and admin_technical of the lane at AAL2; null for everyone else (and when it cannot be
 * read: the banner is advisory, a read problem is logged by class and never takes the page down).
 */
export async function jobFailureBannerFor(g: Pick<Guards, "requireRole">, laneId: string): Promise<JobFailureItem[] | null> {
  let client: Pick<LaneClient, "schema">;
  try {
    ({ client } = await g.requireRole(laneId as Parameters<Guards["requireRole"]>[0], CONNECT_ROLES));
  } catch (e) {
    if (e instanceof AuthError) return null;
    console.error("[job-failures] role check unavailable", { laneId, error: e instanceof Error ? e.name : typeof e });
    return null;
  }
  try {
    const q = (client as unknown as { schema(s: "core"): { from(t: string): { select(c: string): { eq(c: string, v: string): { gte(c: string, v: number): { not(c: string, op: string, v: null): { limit(n: number): PromiseLike<{ data: unknown; error: unknown }> } } } } } } }).schema("core").from("job_failures");
    const { data, error } = await q.select("function_id, consecutive_failures, streak_started_at, last_error_code, alerted_at").eq("lane_id", laneId).gte("consecutive_failures", FAILURE_BANNER_THRESHOLD).not("alerted_at", "is", null).limit(50);
    if (error) throw new Error("read failed");
    const items = toJobFailureItems(data);
    return items.length > 0 ? items : null;
  } catch (e) {
    console.error("[job-failures] banner unavailable", { laneId, error: e instanceof Error ? e.name : typeof e });
    return null;
  }
}
