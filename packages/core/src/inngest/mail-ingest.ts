import "server-only";
// mail.ingest_delta (T-238): the schedule that keeps the mail index fresh. The delta itself is T-063's Gmail history sync
// (historyId per mailbox, full resync when Google answers 404), run by conn.sync for Google connections. This function only
// decides WHEN, exactly like cal-ingest (cal-ingest.ts): every 15 minutes it lists each enabled lane's usable mail-capable
// connections (each connected mailbox) and asks conn.sync to run the mail stream of each.
//   - Before T-238 the mail delta only ran inside the calendar tick (conn.sync ran mail THEN calendar), so a failing calendar
//     could hold mail back and the schedule was hidden. Now mail has its own tick and its own failure record.
//   - Streams: the event asks for ["mail"] only; cal-ingest asks for ["calendar"]. Each stream runs once per tick, never twice.
//   - Offset: the cron is `7-59/15` (minutes 7, 22, 37, 52), not on the calendar's :00/:15/:30/:45. conn.sync has concurrency 1
//     per connection, so two events for one connection queue instead of overlapping; the offset keeps the two ticks from
//     queuing behind each other.
//   - Fan-out: same plan (a lane that cannot be listed is recorded and skipped, never blocking the others), event id
//     `mail-ingest:<connectionId>:<slot>`, trigger "schedule". Ids only; the lane comes only from enabledLanes() and conn.sync
//     validates the event and the lane again on receipt.
//   - Briefing refresh: when a scheduled mail-only run wrote at least one message, the route sends briefing/refresh.requested
//     (see shouldRefreshBriefingAfterSync and briefing-refresh.ts). Never for calendar, a manual run or a run that wrote nothing.
import { NonRetriableError, type Inngest, type InngestFunction } from "inngest";
import { CAL_INGEST_CADENCE_MS, planCalIngest, type CalIngestDeps, type CalIngestPlan } from "./cal-ingest";
import { connSyncRequested } from "./events";

export type MailIngestDeps = CalIngestDeps;
export type MailIngestPlan = CalIngestPlan;

/** Function options, exported so tests assert them. */
export const MAIL_INGEST_CADENCE_MS = CAL_INGEST_CADENCE_MS;
export const MAIL_INGEST_CRON = "7-59/15 * * * *";
export const MAIL_INGEST_RETRIES = 2;

/** The tick a scheduled time belongs to (same 15-minute slots as the calendar's; the offset cron fires inside each slot). */
export function mailIngestSlot(timeMs: number): number {
  if (!Number.isFinite(timeMs) || timeMs < 0) throw new NonRetriableError("mail.ingest_delta: invalid schedule time");
  return Math.floor(timeMs / MAIL_INGEST_CADENCE_MS);
}

/** Deterministic Inngest event id for one connection in one tick. */
export function mailIngestEventId(connectionId: string, slot: number): string {
  return `mail-ingest:${connectionId}:${String(slot)}`;
}

/** Deterministic event id of a lane's briefing refresh in one tick: one per lane per 15-minute slot, however many mailboxes wrote. */
export function briefingRefreshEventId(laneId: string, slot: number): string {
  return `briefing-refresh:${laneId}:${String(slot)}`;
}

/**
 * Whether a finished sync should ask for a briefing refresh: a SCHEDULED Google run of the mail stream alone that wrote at least
 * one message. A run for both streams (manual, connect, webhook) or for the calendar never does.
 */
export function shouldRefreshBriefingAfterSync(run: { provider: string; trigger: string; streams?: readonly string[] | undefined; written: number }): boolean {
  return run.provider === "google" && run.trigger === "schedule" && run.streams?.length === 1 && run.streams[0] === "mail" && Number.isFinite(run.written) && run.written > 0;
}

type StepApi = {
  run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T>;
  sendEvent: (id: string, events: ReturnType<typeof connSyncRequested.create>[]) => Promise<unknown>;
};

/** The function body without Inngest, for tests. `scheduledAtMs` is the cron event time (stable across retries). */
export async function handleMailIngest(deps: MailIngestDeps, scheduledAtMs: unknown, step: StepApi) {
  if (typeof scheduledAtMs !== "number") throw new NonRetriableError("mail.ingest_delta: invalid schedule time");
  const slot = mailIngestSlot(scheduledAtMs);
  const plan: MailIngestPlan = await step.run("plan", () => planCalIngest(deps));
  if (plan.sends.length > 0) {
    await step.sendEvent(
      "fan-out",
      plan.sends.map((s) => connSyncRequested.create({ laneId: s.laneId, connectionId: s.connectionId, trigger: "schedule", streams: ["mail"] }, { id: mailIngestEventId(s.connectionId, slot) })),
    );
  }
  // Fail the run AFTER the healthy lanes were sent. Not retried: the next tick is the retry.
  if (plan.failedLanes.length > 0) throw new NonRetriableError(`mail.ingest_delta: ${String(plan.failedLanes.length)} lane(s) could not be listed`);
  return { lanes: new Set(plan.sends.map((s) => s.laneId)).size, connections: plan.sends.length, slot };
}

export function mailIngestFunction(inngest: Inngest, deps: MailIngestDeps): InngestFunction.Any {
  return inngest.createFunction(
    { id: "mail-ingest-delta", triggers: [{ cron: MAIL_INGEST_CRON }], retries: MAIL_INGEST_RETRIES },
    async ({ event, step }) => handleMailIngest(deps, event.ts, step as unknown as StepApi),
  );
}
