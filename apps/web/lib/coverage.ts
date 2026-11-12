// Coverage (T-234 part 1): what each mail and calendar source last synced and in what state. It used to be a card on Home;
// now it is listed in Settings -> Connections, and Home keeps only a status dot in its header. Same read as the briefing
// (core.briefing_coverage: SECURITY DEFINER, answers only for the caller's comms/calendar views) and the same fixed
// reason texts (domain/coverage.ts: codes only, never provider text, names only). Read-only; no figures.
import type { Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import { parseCoverageRows, toCoverage, type CoverageItem } from "@nichols/briefing/domain";
import { briefingConfigFrom } from "./briefing";

export type CoverageView = { items: CoverageItem[]; unavailable: boolean };

type Db = Pick<LaneClient, "schema">;

/** True when any source is stale or in error (a source that was never connected is not a fault). */
export const needsAttention = (items: CoverageItem[]): boolean => items.some((c) => c.state === "stale" || c.state === "error");

export async function loadCoverage(client: Db, laneId: string, now: Date): Promise<CoverageView> {
  const core = client.schema("core");
  const [cfg, cov] = await Promise.all([core.from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle(), core.rpc("briefing_coverage", { p_lane: laneId })]);
  if (cov.error) throw new Error("coverage unavailable");
  // A role that may not read the config still gets the default stale threshold.
  const { briefing } = briefingConfigFrom(cfg.error ? null : cfg.data?.config);
  return { items: toCoverage(parseCoverageRows(cov.data), now, briefing.coverage_stale_minutes), unavailable: false };
}

/** The lane gate has already run on the page; an outage gives `unavailable`, never an empty list read as "all fine". */
export async function coverageFor(g: Pick<Guards, "requireLane">, laneId: string, now: Date, load = loadCoverage): Promise<CoverageView> {
  try {
    const { client } = await g.requireLane(laneId as Parameters<Guards["requireLane"]>[0]);
    return await load(client, laneId, now);
  } catch (e) {
    console.error("[coverage] unavailable", { laneId, reason: e instanceof Error ? e.name : typeof e });
    return { items: [], unavailable: true };
  }
}
