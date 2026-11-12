"use server";
// "Refresh" on the GovCon news card (T-234 part 4). Order: lane id shape -> AAL2 session + OWNER role (requireRole) -> AI
// configured -> the lane's news config -> runNewsFetch, which reserves the attempt in SQL FIRST (web category, news.enabled,
// one ok refresh per hour (a retry 5 min after a failed one), monthly cap, one in flight: all enforced by core.news_begin_refresh, not here) and only then calls the
// model, bounded by a 70 s time limit (Home's maxDuration is 90 s, so the abort and the closing database call fit). Every database call uses the owner's own lane client, so RLS
// and the definer functions' own checks apply; no service client on this path. Returns a code only. A page render or the
// 5-minute auto-refresh never calls this: the card only reads the stored digest.
import { getLLMProvider } from "@nichols/ai/config";
import type { LaneId } from "@nichols/core";
import { AuthError } from "@nichols/core/auth";
import { revalidatePath } from "next/cache";
import { guards } from "@/lib/guards";
import { beginNews, finishNews } from "@/lib/news";
import { newsConfigFrom } from "@/lib/news-domain";
import { NewsGateError, runNewsFetch } from "@/lib/news-run";
import { NEWS_REFRESH_TIMEOUT_MS, type RefreshNewsState } from "@/lib/news-types";

const LANE = /^[A-Z]{1,8}$/;

export async function refreshNews(laneId: string): Promise<RefreshNewsState> {
  if (typeof laneId !== "string" || !LANE.test(laneId)) return { error: "forbidden" };
  try {
    const g = await guards();
    const { client } = await g.requireRole(laneId as LaneId, ["owner"]);
    // 60 s per call and no SDK retry: a retried call could be billed twice.
    const p = getLLMProvider({ timeoutMs: 60_000, maxRetries: 0 });
    if (!p.configured) return { error: "ai_not_set_up" };
    const cfg = await client.schema("core").from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle();
    if (cfg.error) return { error: "unavailable" };
    const laneName = (await g.listLanes()).find((l) => l.laneId === laneId)?.name ?? laneId;
    const res = await runNewsFetch(
      {
        provider: p.provider,
        begin: (reserve) => beginNews(client, laneId, "refresh", reserve),
        finish: (id, r) => finishNews(client, laneId, "refresh", id, r),
        signal: AbortSignal.timeout(NEWS_REFRESH_TIMEOUT_MS),
      },
      { laneId, laneName, cfg: newsConfigFrom(cfg.data?.config), now: new Date() },
    );
    revalidatePath(`/${laneId}`);
    return { ok: true, status: res.status, ...(res.failureCode ? { failure: res.failureCode } : {}) };
  } catch (e) {
    if (e instanceof AuthError) return { error: "forbidden" };
    if (e instanceof NewsGateError) return { error: e.code === "already_fetched" || e.code === "retry_later" || e.code === "attempts_exhausted" ? "busy" : e.code };
    if (e instanceof Error && e.name === "EnvValidationError") return { error: "ai_not_set_up" };
    console.error("[news] refresh failed", { laneId, error: e instanceof Error ? e.name : typeof e });
    return { error: "unavailable" };
  }
}
