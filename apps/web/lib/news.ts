// GovCon news: database access (T-234 part 4). Every call is lane-scoped and goes through the core.news_* functions:
//   - the owner's Refresh and Home reads use the signed-in user's own lane client (RLS and the function checks apply);
//   - the scheduled job uses the job client the Inngest route injects (briefing-schedule.ts pattern).
// Home only READS here (loadNewsCard); a page render or an auto-refresh can never start a fetch.
import type { LaneClient } from "@nichols/core/lane-router";
import { gateCodeFrom, NewsGateError, type NewsFinish } from "./news-run";
import { newsConfigFrom, normalizeUrl, plainText, reserveUsd } from "./news-domain";
import { NEWS_REFRESH_INTERVAL_MS, type NewsCard, type NewsItem } from "./news-types";

type Db = Pick<LaneClient, "schema">;

/** Reserves one attempt in SQL (gates, cap, rate limit). Throws NewsGateError for a refusal, Error for anything else. */
export async function beginNews(client: Db, laneId: string, trigger: "schedule" | "refresh", reserve: number): Promise<string> {
  const core = client.schema("core");
  const { data, error } = trigger === "refresh" ? await core.rpc("news_begin_refresh", { p_lane: laneId, p_reserve: reserve }) : await core.rpc("news_begin_scheduled", { p_lane: laneId, p_reserve: reserve });
  if (error) {
    const code = gateCodeFrom(error);
    if (code) throw new NewsGateError(code);
    throw new Error(`news begin failed (${error.code ?? "unknown"})`);
  }
  if (typeof data !== "string") throw new Error("news begin failed");
  return data;
}

/** Stores the result of the attempt `id` (SQL re-checks the item shape, https and size). */
export async function finishNews(client: Db, laneId: string, trigger: "schedule" | "refresh", id: string, r: NewsFinish): Promise<void> {
  const args = { p_lane: laneId, p_id: id, p_status: r.status, p_failure_code: r.failureCode as string, p_items: r.items as never, p_searches: r.searches, p_est_cost: r.estCostUsd };
  const core = client.schema("core");
  const { error } = trigger === "refresh" ? await core.rpc("news_finish_own", args) : await core.rpc("news_finish", args);
  if (error) throw new Error(`news finish failed (${error.code ?? "unknown"})`);
}

/** Stored items -> display items. Re-validated on read: https only, plain text (defence in depth against a bad row). */
export function itemsFrom(json: unknown): NewsItem[] {
  if (!Array.isArray(json)) return [];
  const out: NewsItem[] = [];
  for (const raw of json) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const url = normalizeUrl(r.source_url);
    const headline = plainText(r.headline, 300);
    const why = plainText(r.why, 400);
    const source = plainText(r.source_name, 120);
    if (!url || !headline || !why || !source) continue;
    const when = typeof r.published_at === "string" && Number.isFinite(Date.parse(r.published_at)) ? r.published_at : null;
    // The link is the stored string (the tool's own), which normalizeUrl just proved to be a plain https URL.
    out.push({ headline, why, source, publishedAt: when, url: r.source_url as string });
  }
  return out.slice(0, 6);
}

type LatestRow = { items?: unknown; fetched_at?: string | null; last_failure_code?: string | null; last_failed_at?: string | null; last_refresh_at?: string | null; pending_since?: string | null };

/**
 * What Home needs. `isOwner`: may refresh and sees the budget; `isAdmin`: owner or admin_technical (Settings hint).
 * A read that fails is treated as "not configured" / "no items" (the card then shows its empty state), never as an error page.
 */
export async function loadNewsCard(client: Db, laneId: string, opts: { isOwner: boolean; isAdmin: boolean }, now: Date): Promise<NewsCard> {
  const core = client.schema("core");
  const [enabled, latest, spend, cfg] = await Promise.all([
    core.rpc("news_enabled", { p_lane: laneId }),
    core.rpc("news_latest", { p_lane: laneId }),
    opts.isAdmin ? core.rpc("news_spend", { p_lane: laneId }) : Promise.resolve(null),
    opts.isOwner ? core.from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle() : Promise.resolve(null),
  ]);
  const configured = !enabled.error && enabled.data === true;
  const row = (!latest.error && Array.isArray(latest.data) ? (latest.data[0] as LatestRow | undefined) : undefined) ?? null;
  const next = row?.last_refresh_at ? Date.parse(row.last_refresh_at) + NEWS_REFRESH_INTERVAL_MS : null;
  let budgetReached = false;
  const s = spend && !spend.error && Array.isArray(spend.data) ? (spend.data[0] as { month_spend?: number | string; cap_usd?: number | string } | undefined) : undefined;
  if (opts.isOwner && s) {
    const conf = newsConfigFrom(cfg && !cfg.error ? cfg.data?.config : null);
    budgetReached = Number(s.month_spend ?? 0) + reserveUsd(conf) > Number(s.cap_usd ?? 20);
  }
  return {
    configured,
    items: configured ? itemsFrom(row?.items) : [],
    updatedAt: row?.fetched_at && row.items && itemsFrom(row.items).length > 0 ? row.fetched_at : null,
    failure: row?.last_failed_at ? (row.last_failure_code ?? "unknown") : null,
    canRefresh: opts.isOwner && configured,
    nextRefreshAt: next !== null && next > now.getTime() ? new Date(next).toISOString() : null,
    budgetReached,
    isAdmin: opts.isAdmin,
    inFlight: !!row?.pending_since,
  };
}
