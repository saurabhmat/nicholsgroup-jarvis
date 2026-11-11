// briefing/jobs (T-231c): the scheduled side of the daily briefing. Every function takes the client it runs with: only
// the Inngest route (in JOB_RUNNERS) creates the RLS-bypassing job client and passes it in (security review H2), so this
// module neither creates nor re-exports a service client. "Run now" saves through core.briefing_save_own with the
// owner's own client instead.
import type { LaneId } from "@nichols/core";
import type { LaneClient } from "@nichols/core/lane-router";

export type BriefingRecord = {
  ownerUserId: string;
  trigger: "manual" | "schedule";
  status: "ready" | "partial" | "failed";
  windowFrom: string;
  windowTo: string;
  content: unknown;
  coverage: unknown;
  sourceRefs: unknown;
  model: string | null;
};

type Rpc = Pick<LaneClient, "schema">;

/** Stores one scheduled briefing (core.briefing_save is service_role only: `client` must be the job client). */
export async function saveBriefing(client: Rpc, laneId: LaneId, r: BriefingRecord): Promise<string> {
  const { data, error } = await client.schema("core").rpc("briefing_save", {
    p_lane: laneId,
    p_owner: r.ownerUserId,
    p_trigger: r.trigger,
    p_status: r.status,
    p_window_from: r.windowFrom,
    p_window_to: r.windowTo,
    p_content: r.content as never,
    p_coverage: r.coverage as never,
    p_source_refs: r.sourceRefs as never,
    p_model: r.model ?? "none",
  });
  if (error || typeof data !== "string") throw new Error("briefing save failed");
  return data;
}

/** "Run now": the signed-in owner saves their own briefing with their own client (AAL2, owner, briefing view, cooldown in SQL). */
export async function saveOwnBriefing(client: Rpc, laneId: LaneId, r: Omit<BriefingRecord, "ownerUserId" | "trigger">): Promise<string> {
  const { data, error } = await client.schema("core").rpc("briefing_save_own", {
    p_lane: laneId,
    p_status: r.status,
    p_window_from: r.windowFrom,
    p_window_to: r.windowTo,
    p_content: r.content as never,
    p_coverage: r.coverage as never,
    p_source_refs: r.sourceRefs as never,
    p_model: r.model ?? "none",
  });
  if (error) throw new Error(error.message === "too_soon" ? "briefing too_soon" : "briefing save failed");
  if (typeof data !== "string") throw new Error("briefing save failed");
  return data;
}

/** Lane owners (re-checked on every scheduled run; the views are checked by the caller). */
export async function briefingOwners(client: Rpc, laneId: LaneId): Promise<string[]> {
  const { data, error } = await client.schema("core").from("memberships").select("user_id").eq("lane_id", laneId).eq("role", "owner");
  if (error || !Array.isArray(data)) return [];
  return data.flatMap((m: { user_id?: unknown }) => (typeof m.user_id === "string" ? [m.user_id] : []));
}

/** Retention purge (brief.briefings_purge enforces floor, cap and enabled lane). `client` must be the job client. */
export async function purgeBriefings(client: Rpc, laneId: LaneId, keepDays: number): Promise<number> {
  const { data, error } = await client.schema("core").rpc("briefings_purge", { p_lane: laneId, p_keep_days: keepDays });
  if (error || typeof data !== "number") throw new Error("briefing purge failed");
  return data;
}
