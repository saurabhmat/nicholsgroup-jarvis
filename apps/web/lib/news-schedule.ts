// The scheduled GovCon news fetch (T-234 part 4). Wired into the Inngest route, which passes `clientFor` (the job client: only
// the route creates it). `newsDue` is the cheap check (config on, fetch time reached); `runScheduledNews` does one fetch for one
// lane. The SQL gates inside core.news_begin_scheduled are authoritative (web category, once a day, monthly cap, one in flight),
// so a lane that is not configured, or already fetched today, ends as "skipped:<code>" with no model call.
import { getLLMProvider } from "@nichols/ai/config";
import { isNewsTimeReached } from "@nichols/core/inngest";
import { beginNews, finishNews } from "./news";
import { newsConfigFrom } from "./news-domain";
import { NewsGateError, runNewsFetch } from "./news-run";
import type { LaneClient } from "@nichols/core/lane-router";

type Db = Pick<LaneClient, "schema">;
export type ClientFor = (laneId: string) => Promise<Db>;

export async function newsDue(clientFor: ClientFor, laneId: string, now: Date): Promise<boolean> {
  const c = await clientFor(laneId);
  const cfg = await c.schema("core").from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle();
  if (cfg.error) throw new Error("lane config unavailable");
  const news = newsConfigFrom(cfg.data?.config);
  return news.enabled && isNewsTimeReached(news.time, now);
}

/** One scheduled fetch. Returns "fetched" | "failed:<code>" | "skipped:<reason>"; throws only for infrastructure faults. */
export async function runScheduledNews(clientFor: ClientFor, laneId: string, now: Date): Promise<string> {
  const p = getLLMProvider({ timeoutMs: 60_000, maxRetries: 0 });
  if (!p.configured) return "skipped:ai_not_set_up";
  const c = await clientFor(laneId);
  const [cfg, lane] = await Promise.all([
    c.schema("core").from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle(),
    c.schema("core").from("lanes").select("name").eq("code", laneId).maybeSingle(),
  ]);
  if (cfg.error) throw new Error("lane config unavailable");
  try {
    const res = await runNewsFetch(
      {
        provider: p.provider,
        begin: (reserve) => beginNews(c, laneId, "schedule", reserve),
        finish: (id, r) => finishNews(c, laneId, "schedule", id, r),
        signal: AbortSignal.timeout(80_000),
      },
      { laneId, laneName: lane.data?.name ?? laneId, cfg: newsConfigFrom(cfg.data?.config), now },
    );
    return res.status === "failed" ? `failed:${res.failureCode ?? "unknown"}` : "fetched";
  } catch (e) {
    if (e instanceof NewsGateError) return `skipped:${e.code}`;
    throw e;
  }
}
