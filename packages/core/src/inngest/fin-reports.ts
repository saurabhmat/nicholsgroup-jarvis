import "server-only";
// fin.qbo_reports (T-052): the QuickBooks report pull into fin.report_cache. The pull itself (connector, settings, payroll
// policy, store) is injected as `runReports` (apps/web wires @nichols/connectors/reports; core cannot import connectors).
//   - fin-qbo-reports-schedule: nightly at 02:00 America/New_York, off-hours and before the Saturday 06:00 weekly cash
//     report reads the cache. Step "plan" lists every enabled lane's usable QuickBooks connections (a lane that cannot be
//     listed is recorded and skipped, never blocking the others); step "fan-out" sends fin/qbo-reports.requested with the
//     deterministic id `fin-reports:<connectionId>:<day>`, so Inngest drops a duplicate of the same night.
//   - fin-qbo-reports-connection: one connection per run. Concurrency key = connection id, limit 1; retries with backoff
//     for transient failures (honouring a provider retry-after); permanent ones (reconnect_required, a refused report,
//     an invalid setting) stop at once. A retry adds newer cache rows (as_of is Intuit's report time); it never alters old ones.
//   - The weekly cash job (T-089) sends the same event with trigger "weekly_cash" when it needs a fresh pull.
// Events carry ids only; the lane must be one this deployment serves, checked again on receipt.
import { NonRetriableError, RetryAfterError, type Inngest, type InngestFunction } from "inngest";
import { finQboReportsRequested } from "./events";

/** Mirrors QboReportsOutcome in @nichols/connectors/reports (structural: core does not import connectors). */
export type FinQboReportsResult =
  | { ok: true; skipped: null; stored: string[]; excludedRows: number }
  | { ok: true; skipped: "connection_not_usable" }
  | { ok: false; retryable: boolean; retryAfterSeconds: number | null; errorKind: string; message: string; stored: string[] };

export type FinQboReportsDeps = {
  runReports: (laneId: string, connectionId: string) => Promise<FinQboReportsResult>;
  /** Usable QuickBooks connection ids of the lane. */
  listConnections: (laneId: string) => Promise<readonly string[]>;
  enabledLanes: () => readonly string[];
};

/** Function options, exported so tests assert them. */
export const FIN_REPORTS_CRON = "TZ=America/New_York 0 2 * * *";
export const FIN_REPORTS_SCHEDULE_RETRIES = 2;
export const FIN_REPORTS_RETRIES = 3;
export const FIN_REPORTS_CONCURRENCY = { key: "event.data.connectionId", limit: 1 } as const;
const MAX_RETRY_AFTER_SECONDS = 15 * 60;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Deterministic Inngest event id for one connection on one (UTC) day of the schedule. */
export function finReportsEventId(connectionId: string, scheduledAtMs: number): string {
  if (!Number.isFinite(scheduledAtMs) || scheduledAtMs < 0) throw new NonRetriableError("fin.qbo_reports: invalid schedule time");
  return `fin-reports:${connectionId}:${String(Math.floor(scheduledAtMs / DAY_MS))}`;
}

export type FinReportsPlan = { sends: { laneId: string; connectionId: string }[]; failedLanes: string[] };

export async function planFinReports(deps: Pick<FinQboReportsDeps, "listConnections" | "enabledLanes">): Promise<FinReportsPlan> {
  const sends: FinReportsPlan["sends"] = [];
  const failedLanes: string[] = [];
  for (const laneId of new Set(deps.enabledLanes())) {
    try {
      for (const connectionId of new Set(await deps.listConnections(laneId))) {
        if (UUID.test(connectionId)) sends.push({ laneId, connectionId });
      }
    } catch {
      failedLanes.push(laneId);
    }
  }
  return { sends, failedLanes };
}

type StepApi = {
  run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T>;
  sendEvent: (id: string, events: ReturnType<typeof finQboReportsRequested.create>[]) => Promise<unknown>;
};

/** The schedule body without Inngest, for tests. */
export async function handleFinReportsSchedule(deps: FinQboReportsDeps, scheduledAtMs: unknown, step: StepApi) {
  if (typeof scheduledAtMs !== "number") throw new NonRetriableError("fin.qbo_reports: invalid schedule time");
  const at = scheduledAtMs;
  finReportsEventId("00000000-0000-4000-8000-000000000000", at); // validates the time before any work
  const plan: FinReportsPlan = await step.run("plan", () => planFinReports(deps));
  if (plan.sends.length > 0) {
    await step.sendEvent(
      "fan-out",
      plan.sends.map((s) => finQboReportsRequested.create({ laneId: s.laneId, connectionId: s.connectionId, trigger: "schedule" }, { id: finReportsEventId(s.connectionId, at) })),
    );
  }
  // Fail the run (visible in Inngest) AFTER the healthy lanes were sent; not retried: the next night is the retry.
  if (plan.failedLanes.length > 0) throw new NonRetriableError(`fin.qbo_reports: ${String(plan.failedLanes.length)} lane(s) could not be listed`);
  return { lanes: new Set(plan.sends.map((s) => s.laneId)).size, connections: plan.sends.length };
}

/** The per-connection body without Inngest, for tests: throws what Inngest needs to decide about a retry. */
export async function handleFinReports(
  deps: Pick<FinQboReportsDeps, "runReports" | "enabledLanes">,
  data: { laneId: string; connectionId: string; trigger: string },
): Promise<Exclude<FinQboReportsResult, { ok: false }> | { ok: true; skipped: "lane_not_served" }> {
  // Events can reach Inngest without passing sendLaneEvent: validate again, echo nothing.
  const parsed = await finQboReportsRequested.schema["~standard"].validate(data);
  if (parsed.issues) throw new NonRetriableError("fin.qbo_reports: invalid event data");
  if (!deps.enabledLanes().includes(data.laneId)) return { ok: true, skipped: "lane_not_served" };
  const result = await deps.runReports(data.laneId, data.connectionId);
  if (result.ok) return result;
  // Messages are already redacted (ConnectorError); they carry no tokens or report content.
  if (!result.retryable) throw new NonRetriableError(`fin.qbo_reports failed: ${result.errorKind}`);
  if (result.retryAfterSeconds !== null && result.retryAfterSeconds > 0) {
    throw new RetryAfterError(`fin.qbo_reports failed: ${result.errorKind}`, Math.min(result.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS) * 1000);
  }
  throw new Error(`fin.qbo_reports failed: ${result.errorKind}`);
}

export function finQboReportsFunctions(inngest: Inngest, deps: FinQboReportsDeps): InngestFunction.Any[] {
  const schedule = inngest.createFunction(
    { id: "fin-qbo-reports-schedule", triggers: [{ cron: FIN_REPORTS_CRON }], retries: FIN_REPORTS_SCHEDULE_RETRIES },
    async ({ event, step }) => handleFinReportsSchedule(deps, event.ts, step as unknown as StepApi),
  );
  const worker = inngest.createFunction(
    { id: "fin-qbo-reports-connection", triggers: [finQboReportsRequested], retries: FIN_REPORTS_RETRIES, concurrency: FIN_REPORTS_CONCURRENCY },
    async ({ event }) => handleFinReports(deps, event.data),
  );
  return [schedule, worker];
}
