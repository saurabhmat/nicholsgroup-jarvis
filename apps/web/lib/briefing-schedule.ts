// The scheduled briefing (T-231c): which owners are due, and one run. Wired into the Inngest route, which passes
// `clientFor` (the job client: only the route creates it). Off unless lane_config.briefing.schedule_enabled is true.
// Every run re-checks the owner's membership and views (briefing, comms, calendar). The job client reads the whole lane's
// mail index: today an owner may see every mailbox in the lane (comms RLS is per lane, not per mailbox), so this equals
// what the owner's own Home sees. If RLS ever narrows to a mailbox or connection, this path must filter by owner.
// The brain profile needs the owner's session, so a scheduled run goes without it (note "no_brain_in_schedule").
import { getLLMProvider } from "@nichols/ai/config";
import type { LaneId } from "@nichols/core";
import { isBriefingDue } from "@nichols/core/inngest";
import { briefingOwners, saveBriefing } from "@nichols/briefing/jobs";
import { readGmailBody } from "@nichols/connectors/google";
import { BUSINESS_TZ } from "@nichols/briefing/domain";
import { briefingConfigFrom } from "./briefing";
import { policyFrom, runBriefing } from "./briefing-run";
import { replyProposer } from "./briefing-proposals";

type Db = Parameters<typeof briefingOwners>[0] & Parameters<typeof runBriefing>[0]["client"];
export type ClientFor = (laneId: string) => Promise<Db>;

const VIEWS = ["briefing", "comms", "calendar"] as const;

/** Owners of the lane who still hold the briefing, comms and calendar views (re-checked on every run). */
export async function ownersWithViews(clientFor: ClientFor, laneId: string): Promise<string[]> {
  const c = await clientFor(laneId);
  const owners = await briefingOwners(c, laneId as LaneId);
  const allowed = await Promise.all(
    owners.map(async (uid) => {
      const views = await Promise.all(VIEWS.map((v) => c.schema("core").rpc("allowed_lanes", { p_uid: uid, p_view: v })));
      return views.every((r) => !r.error && Array.isArray(r.data) && (r.data as unknown[]).includes(laneId)) ? uid : null;
    }),
  );
  return allowed.filter((u): u is string => u !== null);
}

export async function dueOwners(clientFor: ClientFor, laneId: string, now: Date): Promise<string[]> {
  const c = await clientFor(laneId);
  const cfg = await c.schema("core").from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle();
  if (cfg.error) return [];
  const { briefing } = briefingConfigFrom(cfg.data?.config);
  if (!briefing.schedule_enabled || !isBriefingDue(briefing.time, briefing.days, now)) return [];
  return ownersWithViews(clientFor, laneId);
}

/** The scheduled run's bound: under the Inngest route's maxDuration (120 s), leaving time for the save. */
export const SCHEDULE_RUN_TIMEOUT_MS = 100_000;

/** One scheduled run. Throws when the model failed, so the Inngest step retries (the failed attempt is still saved). */
export async function runScheduled(clientFor: ClientFor, laneId: string, ownerUserId: string, now: Date): Promise<string> {
  const p = getLLMProvider();
  if (!p.configured) throw new Error("model not configured");
  const c = await clientFor(laneId);
  const pol = await c.schema("core").from("lane_policies").select("llm_allowed_categories, store_outbound_drafts").eq("lane_id", laneId).maybeSingle();
  if (pol.error) throw new Error("lane policy unavailable");
  // Tracking (T-235): the claim counts toward the lane's daily cap and is never refused by it; the job's save closes it. A day
  // that already has a FINISHED scheduled run answers gate "done": an Inngest retry then skips instead of paying for another
  // model call (re-check M1). A failure to record the claim must not stop the briefing.
  const claim = await c.schema("core").rpc("briefing_claim_schedule", { p_lane: laneId, p_owner: ownerUserId }).then(
    (r) => {
      if (r.error) console.error("[briefing] schedule claim not recorded", { laneId });
      return r.error ? null : (r.data as { id?: unknown; gate?: unknown } | null);
    },
    () => {
      console.error("[briefing] schedule claim not recorded", { laneId });
      return null;
    },
  );
  if (claim?.gate === "done") return typeof claim.id === "string" ? claim.id : "done";
  const res = await runModel(c, p.provider, pol.data, laneId, ownerUserId, now);
  if (res.status === "failed") throw new Error("briefing model step failed");
  return res.id;
}

/** The model run shared by the scheduled and the refresh paths (the claim is the caller's business). */
async function runModel(c: Db, provider: Extract<ReturnType<typeof getLLMProvider>, { configured: true }>["provider"], policyRow: unknown, laneId: string, ownerUserId: string, now: Date) {
  return runBriefing(
    {
      client: c,
      provider,
      readBody: async (l, conn, m) => (await readGmailBody(l, conn, m)).text,
      brain: { brainUser: null, laneBrain: {}, notes: ["no_brain_in_schedule"] },
      policy: policyFrom(policyRow as Parameters<typeof policyFrom>[0]),
      save: (l, r) => saveBriefing(c, l, r),
      proposeReply: replyProposer(ownerUserId),
      // T-236 review L1: both model calls (a cut-off reply's retry included) stop before Inngest's maxDuration (120 s), so a
      // slow run is saved as a timeout and its claim closed, instead of the function being killed with the claim open.
      signal: AbortSignal.timeout(SCHEDULE_RUN_TIMEOUT_MS),
    },
    { laneId: laneId as LaneId, ownerUserId, trigger: "schedule", now, viewerTz: BUSINESS_TZ },
  );
}

/**
 * The refresh after new mail (T-238): asks the EXISTING run claim (core.briefing_claim_refresh = brief.briefing_claim kind 'auto':
 * 3 h stale, one running, 6 per lane and day, 10-minute pause). Any gate, or a claim that cannot be recorded, means NO model call:
 * "refused". Only a granted claim runs the briefing (trigger recorded as "schedule"); its claim is closed after the run (done,
 * failed, or lost when the run died). Throws when the model step failed, so the Inngest step is retried by its retry policy.
 */
export async function runRefresh(clientFor: ClientFor, laneId: string, ownerUserId: string, now: Date): Promise<"ran" | "refused" | "skipped"> {
  const p = getLLMProvider();
  if (!p.configured) return "skipped"; // no model, nothing to refresh (and nothing claimed)
  const c = await clientFor(laneId);
  const pol = await c.schema("core").from("lane_policies").select("llm_allowed_categories, store_outbound_drafts").eq("lane_id", laneId).maybeSingle();
  if (pol.error) throw new Error("lane policy unavailable");
  const claim = await c.schema("core").rpc("briefing_claim_refresh", { p_lane: laneId, p_owner: ownerUserId });
  if (claim.error) throw new Error("claim unavailable");
  const res0 = claim.data as { id?: unknown; gate?: unknown } | null;
  if (typeof res0?.gate === "string") return "refused";
  if (typeof res0?.id !== "string") return "refused";
  const close = async (status: "done" | "failed" | "lost") => {
    try {
      await c.schema("core").rpc("briefing_claim_refresh_close", { p_lane: laneId, p_owner: ownerUserId, p_status: status });
    } catch {
      console.error("[briefing] refresh claim not closed", { laneId }); // the claim is closed as lost after 10 minutes
    }
  };
  let res;
  try {
    res = await runModel(c, p.provider, pol.data, laneId, ownerUserId, now);
  } catch {
    await close("lost");
    throw new Error("briefing refresh run died");
  }
  await close(res.status === "failed" ? "failed" : "done");
  if (res.status === "failed") throw new Error("briefing model step failed");
  return "ran";
}
