// briefing/jobs (T-231c): the scheduled side of the daily briefing. Every function takes the client it runs with: only
// the Inngest route (in JOB_RUNNERS) creates the RLS-bypassing job client and passes it in (security review H2), so this
// module neither creates nor re-exports a service client. the owner's background run saves through core.briefing_save_own with the
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

/** The owner's own run (auto summary, Regenerate): the signed-in owner saves their own briefing with their own client (AAL2, owner, briefing view, cooldown in SQL). */
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

/**
 * T-247: the users who own at least one active mailbox in the lane: a briefing is per person, built from that person's own mailboxes
 * only, so the scheduled job runs once per such user (not per lane owner). Distinct, in a stable order. `client` must be the job client.
 * The caller re-checks that each still holds own_mail in the lane (core.allowed_lanes) before running.
 */
export async function briefingOwners(client: Rpc, laneId: LaneId): Promise<string[]> {
  const { data, error } = await client
    .schema("core")
    .from("connections")
    .select("owner_user_id")
    .eq("lane_id", laneId)
    .in("provider", ["google", "microsoft"])
    .eq("transport", "native") // Composio rows index no mail yet (T-247 review)
    .in("status", ["active", "degraded"])
    .not("owner_user_id", "is", null);
  if (error || !Array.isArray(data)) return [];
  const ids = data.flatMap((m: { owner_user_id?: unknown }) => (typeof m.owner_user_id === "string" ? [m.owner_user_id] : []));
  return [...new Set(ids)].sort();
}

/** Retention purge (brief.briefings_purge enforces floor, cap and enabled lane). `client` must be the job client. */
export async function purgeBriefings(client: Rpc, laneId: LaneId, keepDays: number): Promise<number> {
  const { data, error } = await client.schema("core").rpc("briefings_purge", { p_lane: laneId, p_keep_days: keepDays });
  if (error || typeof data !== "number") throw new Error("briefing purge failed");
  return data;
}

/** Run-claim retention (T-235; brief.briefing_runs_purge: floor 1 day, by New York day). `client` must be the job client. */
export async function purgeBriefingRuns(client: Rpc, laneId: LaneId, keepDays: number): Promise<number> {
  const { data, error } = await client.schema("core").rpc("briefing_runs_purge", { p_lane: laneId, p_keep_days: keepDays });
  if (error || typeof data !== "number") throw new Error("briefing runs purge failed");
  return data;
}

/** News retention (brief.news_purge: floor 1 day, lane cap, never this month's rows). `client` must be the job client. */
export async function purgeNews(client: Rpc, laneId: LaneId, keepDays: number): Promise<number> {
  const { data, error } = await client.schema("core").rpc("news_purge", { p_lane: laneId, p_keep_days: keepDays });
  if (error || typeof data !== "number") throw new Error("news purge failed");
  return data;
}
