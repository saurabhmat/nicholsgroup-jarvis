import "server-only";
// briefing.refresh (T-238): new mail arrived (a scheduled mail sync wrote at least one message), so the lane's summary may be
// out of date. For each owner who still holds the briefing view, the injected `refresh` asks the EXISTING run claim
// (brief.briefing_claim, kind 'auto'): stale after 3 hours, 6 runs per lane and New York day, one running, 10-minute pause. When
// the claim refuses, nothing is called: no model, no cost. This function never bypasses those gates; it only offers a run.
//   - One event per lane per 15-minute slot (event id from mail-ingest), so one tick starts at most one refresh per lane.
//   - Each (lane, owner, slot) is its own step with the slot in the step id, so a retried tick never claims twice.
//   - A failure here never fails the sync: the event is sent by conn.sync's afterSync, whose failure is only reported as
//     followUp "failed". A failed owner is recorded by lane id only; the others still run; the run fails after all were tried.
// core cannot import modules: apps/web injects the owners and the run (lib/briefing-schedule.ts with the job client).
import { NonRetriableError, type Inngest, type InngestFunction } from "inngest";
import { briefingRefreshRequested } from "./events";

export type BriefingRefreshOutcome = "ran" | "refused" | "skipped";
export type BriefingRefreshDeps = {
  enabledLanes: () => readonly string[];
  /** Owners of the lane who still hold the briefing, comms and calendar views. */
  owners: (laneId: string) => Promise<string[]>;
  /** Asks the claim and runs the briefing when it says yes. Returns "refused" (a gate said no; no model call) or "ran". Throws when the model step failed. */
  refresh: (laneId: string, ownerUserId: string, now: Date) => Promise<BriefingRefreshOutcome>;
};

export const BRIEFING_REFRESH_RETRIES = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type StepApi = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

/** The function body without Inngest, for tests. `slot` is the 15-minute slot taken from the event id (stable across retries). */
export async function handleBriefingRefresh(deps: BriefingRefreshDeps, data: unknown, slot: string, step: StepApi, now: Date) {
  const parsed = await briefingRefreshRequested.schema["~standard"].validate(data);
  if (parsed.issues) throw new NonRetriableError("briefing.refresh: invalid event data");
  const laneId = (parsed.value as { laneId: string }).laneId;
  if (!deps.enabledLanes().includes(laneId)) return { ran: 0, refused: 0, skipped: 0, lane: "not_served" as const };
  const owners = (await step.run(`owners-${laneId}-${slot}`, () => deps.owners(laneId))).filter((o) => UUID.test(o));
  const counts = { ran: 0, refused: 0, skipped: 0 };
  let failed = 0;
  for (const owner of owners) {
    try {
      const out = await step.run(`refresh-${laneId}-${owner}-${slot}`, () => deps.refresh(laneId, owner, now));
      counts[out === "ran" ? "ran" : out === "refused" ? "refused" : "skipped"] += 1;
    } catch {
      failed += 1;
    }
  }
  if (failed > 0) throw new NonRetriableError(`briefing.refresh: ${String(failed)} owner run(s) failed for lane ${laneId}`);
  return { ...counts, lane: "served" as const };
}

export function briefingRefreshFunction(inngest: Inngest, deps: BriefingRefreshDeps): InngestFunction.Any {
  return inngest.createFunction(
    { id: "briefing-refresh", triggers: [briefingRefreshRequested], retries: BRIEFING_REFRESH_RETRIES },
    async ({ event, step }) => handleBriefingRefresh(deps, event.data, typeof event.id === "string" ? event.id : String(event.ts), step as unknown as StepApi, new Date()),
  );
}
