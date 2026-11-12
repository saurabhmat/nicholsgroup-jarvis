// GovCon news status for Settings (T-234 part 4): read-only, for the owner and admin_technical. Shows whether news is configured
// (web category on in the lane policy AND news.enabled in lane_config), the month-to-date spend estimate against the cap and the
// last attempt. Spend is an ESTIMATE from lane_config prices (backlog Needs human: verify against the vendor's price list).
// Editing stays where it is (lane_config versions and the lane policy are changed by a human step), nothing here writes.
import type { Guards } from "@nichols/core/auth";
import { newsFailureText } from "./news-types";

export type NewsSettingsView = {
  webAllowed: boolean;
  enabled: boolean;
  capUsd: number;
  monthSpendUsd: number;
  monthFetches: number;
  lastStatus: string | null;
  lastFailure: string | null;
  lastFetchAt: string | null;
};

type Row = {
  web_allowed?: boolean;
  news_enabled?: boolean;
  cap_usd?: number | string;
  month_spend?: number | string;
  month_fetches?: number;
  last_status?: string | null;
  last_failure_code?: string | null;
  last_fetch_at?: string | null;
};

/** null for anyone who may not see it (and on an outage: the section is then simply not drawn). */
export async function newsSectionFor(g: Pick<Guards, "requireRole">, laneId: string): Promise<NewsSettingsView | null> {
  try {
    const { client } = await g.requireRole(laneId as Parameters<Guards["requireRole"]>[0], ["owner", "admin_technical"]);
    const { data, error } = await client.schema("core").rpc("news_spend", { p_lane: laneId });
    const r = !error && Array.isArray(data) ? (data[0] as Row | undefined) : undefined;
    if (!r) return null;
    return {
      webAllowed: r.web_allowed === true,
      enabled: r.news_enabled === true,
      capUsd: Number(r.cap_usd ?? 20),
      monthSpendUsd: Number(r.month_spend ?? 0),
      monthFetches: Number(r.month_fetches ?? 0),
      lastStatus: r.last_status ?? null,
      lastFailure: r.last_status === "failed" ? newsFailureText(r.last_failure_code) : null,
      lastFetchAt: r.last_fetch_at ?? null,
    };
  } catch {
    return null;
  }
}
