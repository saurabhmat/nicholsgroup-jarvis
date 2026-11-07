// The user's home lane (spec §3 "Home lane", review finding 5). Owner-wide pages (About-Me, Preferences, a cross-company
// employee, imports) live in the home lane:
//   1. the lane that already holds the user's About-Me (it never moves silently; "Move to Personal" is an explicit action);
//   2. else the Personal lane, once it is enabled for the user (the caller passes its code from configuration: no lane
//      code is hard-coded here, rule 2);
//   3. else the lane the user picked in setup;
//   4. else the only lane they can open; otherwise the setup must ask.
// `openLanes` are lanes the user may open the brain in (lane router + the brain view), never a hard-coded list.
import type { LaneId } from "@nichols/core";

export type HomeLaneInput = {
  openLanes: readonly LaneId[];
  /** The lane core.brain_home_lane() reported, if any. */
  existingLaneId?: LaneId | null;
  /** The Personal lane's code from configuration, when the deployment has one. */
  personalLaneId?: LaneId | null;
  /** The lane picked in the setup wizard. */
  pickedLaneId?: LaneId | null;
};

export type HomeLaneResult = { ok: true; laneId: LaneId } | { ok: false; reason: "no_lane" | "needs_pick" | "home_lane_unavailable" };

export function resolveHomeLane(input: HomeLaneInput): HomeLaneResult {
  const open = new Set(input.openLanes);
  if (open.size === 0) return { ok: false, reason: "no_lane" };
  const usable = (laneId: LaneId | null | undefined): laneId is LaneId => typeof laneId === "string" && open.has(laneId);
  if (typeof input.existingLaneId === "string") {
    // The About-Me lane never moves silently: if it can no longer be opened (membership removed, lane disabled) the
    // caller must ask, not seed a second About-Me elsewhere (code review M5).
    return usable(input.existingLaneId) ? { ok: true, laneId: input.existingLaneId } : { ok: false, reason: "home_lane_unavailable" };
  }
  if (usable(input.personalLaneId)) return { ok: true, laneId: input.personalLaneId };
  if (usable(input.pickedLaneId)) return { ok: true, laneId: input.pickedLaneId };
  if (open.size === 1) return { ok: true, laneId: [...open][0] as LaneId };
  return { ok: false, reason: "needs_pick" };
}
