import "server-only";
// Failure tracking for scheduled functions (T-238 part E). `withFailureTracking(inngest, tracker)` returns the same client with
// createFunction wrapped, so every function created through it that is TRIGGERED BY A CRON (and conn.sync runs started by the
// schedule) is tracked without touching each function:
//   - a run that still FAILED after its retries counts once (Inngest's onFailure, which runs only when retries are used up);
//   - a run that completes resets the count (a conn.sync run that was skipped, e.g. already running, neither counts nor resets);
//   - the count is per (lane, function id, connection id or '') (conn.sync per stream: "conn-sync.mail", "conn-sync.calendar"): a cron that serves every lane records against every enabled
//     lane (its failure is not about one lane), conn.sync against its own lane and connection;
//   - when a streak reaches 3 the tracker says so once (alert = true) and ONE error-level log line is written: ids and a short
//     code only (never the error message: it may carry text from a provider);
//   - recording never fails the run or the failure handler: the tracker's own errors are swallowed (logged by class only).
// The function bodies are not changed. Crons that call step.* are fine: the success mark runs after the handler returned, which
// happens only once all steps are done. The tracker (apps/web) writes through core.job_failure_record / core.job_failure_clear.
// Event-triggered functions other than conn.sync are not tracked (their events are not schedules).
import type { Inngest } from "inngest";

export const FAILURE_ALERT_THRESHOLD = 3;
export const TRACKED_EVENT_FUNCTION = "conn-sync";

export type FailureTracker = {
  enabledLanes: () => readonly string[];
  /** Counts one failed run. `alert` is true exactly once per streak, when it reaches FAILURE_ALERT_THRESHOLD. */
  recordFailure: (laneId: string, functionId: string, connectionId: string, code: string) => Promise<{ consecutive: number; alert: boolean }>;
  recordSuccess: (laneId: string, functionId: string, connectionId: string) => Promise<void>;
};

const LANE = /^[A-Z]{1,8}$/;
const UUID_OK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The only codes a row may hold: connector error kinds, "lane_unavailable" and "failed". Anything else becomes "failed". */
const CODES: ReadonlySet<string> = new Set([
  "lane_mismatch", "connection_unavailable", "reconnect_required", "unsupported_op", "invalid_input", "rate_limited", "transient", "timeout", "not_found", "forbidden", "provider_error",
  "lane_unavailable", "failed",
]);

/** A short code for an error: the connector kind in "conn.sync failed: <kind>", "lane_unavailable" for a fan-out that could not list a lane, else "failed". Never the message. */
export function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const kind = /failed: ([a-z_]{1,32})$/.exec(message)?.[1];
  if (kind && CODES.has(kind)) return kind;
  if (/could not be listed$/.test(message)) return "lane_unavailable";
  return "failed";
}

type Kind = "cron" | "event";
const hasCron = (triggers: unknown): boolean => Array.isArray(triggers) && triggers.some((t) => typeof t === "object" && t !== null && "cron" in t);
const kindOf = (opts: { id?: unknown; triggers?: unknown }): Kind | null => (opts.id === TRACKED_EVENT_FUNCTION ? "event" : hasCron(opts.triggers) ? "cron" : null);

type Target = { laneId: string; connectionId: string; functionId: string };

/** Who a run counts against: every enabled lane for a cron; the event's own lane and connection for a scheduled conn.sync; nobody otherwise. */
function targets(kind: Kind, tracker: FailureTracker, functionId: string, eventData: unknown): Target[] {
  if (kind === "cron") return [...new Set(tracker.enabledLanes())].filter((l) => LANE.test(l)).map((laneId) => ({ laneId, connectionId: "", functionId }));
  const d = (typeof eventData === "object" && eventData !== null ? eventData : {}) as { laneId?: unknown; connectionId?: unknown; trigger?: unknown; streams?: unknown };
  if (d.trigger !== "schedule" || typeof d.laneId !== "string" || !LANE.test(d.laneId) || typeof d.connectionId !== "string" || !UUID_OK.test(d.connectionId)) return [];
  if (!tracker.enabledLanes().includes(d.laneId)) return [];
  // The schedule runs mail and calendar as separate events (T-238 A), so each stream has its own streak: a calendar that keeps failing
  // must not be reset by the mail run that succeeds between its failures.
  const only = Array.isArray(d.streams) && d.streams.length === 1 && (d.streams[0] === "mail" || d.streams[0] === "calendar") ? d.streams[0] : null;
  return [{ laneId: d.laneId, connectionId: d.connectionId.toLowerCase(), functionId: only ? `${functionId}.${only}` : functionId }];
}

async function recordFailed(kind: Kind, tracker: FailureTracker, functionId: string, eventData: unknown, error: unknown): Promise<void> {
  const code = failureCode(error);
  await Promise.all(
    targets(kind, tracker, functionId, eventData).map(async (t) => {
      try {
        const r = await tracker.recordFailure(t.laneId, t.functionId, t.connectionId, code);
        if (r.alert) console.error("[job-alert] a scheduled function failed 3 times in a row", { laneId: t.laneId, functionId: t.functionId, connectionId: t.connectionId, code, failures: r.consecutive });
      } catch (e) {
        console.error("[job-alert] failure not recorded", { laneId: t.laneId, functionId, error: e instanceof Error ? e.name : typeof e });
      }
    }),
  );
}

async function recordOk(kind: Kind, tracker: FailureTracker, functionId: string, eventData: unknown): Promise<void> {
  await Promise.all(
    targets(kind, tracker, functionId, eventData).map(async (t) => {
      try {
        await tracker.recordSuccess(t.laneId, t.functionId, t.connectionId);
      } catch (e) {
        console.error("[job-alert] success not recorded", { laneId: t.laneId, functionId, error: e instanceof Error ? e.name : typeof e });
      }
    }),
  );
}

type Ctx = { event?: { data?: unknown }; error?: unknown };
type CreateFunction = (options: Record<string, unknown>, handler: (ctx: Ctx) => unknown) => unknown;

export function withFailureTracking(inngest: Inngest, tracker: FailureTracker): Inngest {
  const create = (inngest as unknown as { createFunction: CreateFunction }).createFunction.bind(inngest);
  const tracked: CreateFunction = (options, handler) => {
    const kind = kindOf(options);
    const id = typeof options.id === "string" ? options.id : "";
    if (kind === null || id === "") return create(options, handler);
    return create(
      {
        ...options,
        // Runs only when the function ran out of retries: the event is Inngest's function.failed, whose data holds the original event.
        onFailure: async (ctx: Ctx) => {
          const original = (ctx.event?.data as { event?: { data?: unknown } } | undefined)?.event?.data;
          await recordFailed(kind, tracker, id, original, ctx.error);
        },
      },
      async (ctx) => {
        const out = await handler(ctx);
        // A conn.sync that did not run (already running, not usable) is neither a success nor a failure.
        const skipped = typeof out === "object" && out !== null && typeof (out as { skipped?: unknown }).skipped === "string";
        if (!skipped) await recordOk(kind, tracker, id, ctx.event?.data);
        return out;
      },
    );
  };
  return new Proxy(inngest, {
    get(target, prop) {
      if (prop === "createFunction") return tracked;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
