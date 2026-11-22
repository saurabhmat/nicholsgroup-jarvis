"use server";
// "Refresh" on the GovCon news card (T-234 part 4; asynchronous since T-249). Order: lane id shape -> AAL2 session + OWNER role
// (requireRole) -> AI configured -> the lane's news config -> the attempt is reserved in SQL (core.news_begin_refresh: web
// category, news.enabled, one ok refresh per hour (a retry 5 min after a failed one), monthly cap, one in flight). A refusal is
// returned at once as a code and the model is never called. Only after a reservation does the fetch go into Next's after(): the
// action returns {ok, status: "started"} immediately and the card shows "A fetch is running." while it re-reads the page
// (news-refresh.tsx). The fetch is bounded at NEWS_FETCH_TIMEOUT_MS (240 s; Home's maxDuration is 300 s, so the abort and the
// closing database call fit). If the run never closes its row (a crash), SQL closes it as lost after 10 minutes. Every database
// call uses the owner's own lane client, captured before after(), so RLS and the definer functions' own checks apply; no
// service client on this path. That client keeps the access token it was built with (no auto-refresh), so the session is renewed
// first when the token would not outlive the fetch (security review H1), and nothing is reserved unless the verified token does. Returns a code only. A page render or the 5-minute auto-refresh never calls this: the card only
// reads the stored digest.
import { getLLMProvider } from "@nichols/ai/config";
import type { LaneId } from "@nichols/core";
import { AuthError } from "@nichols/core/auth";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { guards, renewSessionFor } from "@/lib/guards";
import { laneGate } from "@/lib/lane-modules";
import { beginNews, finishNews } from "@/lib/news";
import { newsConfigFrom, reserveUsd } from "@/lib/news-domain";
import { NewsGateError, runNewsFetch } from "@/lib/news-run";
import { NEWS_CALL_TIMEOUT_MS, NEWS_FETCH_TIMEOUT_MS, NEWS_RETRY_BEFORE_MS, type RefreshNewsState } from "@/lib/news-types";

const LANE = /^[A-Z]{1,8}$/;
/** Seconds the owner's access token must still be valid for when the fetch is handed to after(): the fetch bound plus 60 s. */
const SESSION_NEEDED_S = Math.ceil(NEWS_FETCH_TIMEOUT_MS / 1000) + 60;

export async function refreshNews(laneId: string): Promise<RefreshNewsState> {
  if (typeof laneId !== "string" || !LANE.test(laneId)) return { error: "forbidden" };
  try {
    // The background fetch and its closing call need the token for NEWS_FETCH_TIMEOUT_MS plus a margin. The renewal runs before
    // the guards on purpose (they must read the renewed cookies); it only rotates the caller's OWN session, as proxy.ts does on
    // every request, and grants nothing: the role and AAL2 checks follow.
    await renewSessionFor(SESSION_NEEDED_S);
    const g = await guards();
    const { client, session } = await g.requireRole(laneId as LaneId, ["owner"]);
    if (!(await laneGate(laneId)).newsShown) return { error: "forbidden" }; // T-265: a limited company that has not turned news on
    if (session.expiresAt === undefined || session.expiresAt - Math.floor(Date.now() / 1000) < SESSION_NEEDED_S) {
      console.error("[news] refresh refused: session too short", { laneId });
      return { error: "unavailable" };
    }
    // One request at most NEWS_CALL_TIMEOUT_MS and no SDK retry: a retried call could be billed twice.
    const p = getLLMProvider({ timeoutMs: NEWS_CALL_TIMEOUT_MS, maxRetries: 0 });
    if (!p.configured) return { error: "ai_not_set_up" };
    const cfgRow = await client.schema("core").from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle();
    if (cfgRow.error) return { error: "unavailable" };
    const cfg = newsConfigFrom(cfgRow.data?.config);
    const laneName = (await g.listLanes()).find((l) => l.laneId === laneId)?.name ?? laneId;
    // The reservation runs here, not in after(), so a refusal (once an hour, cap, one in flight) reaches the owner at once.
    const id = await beginNews(client, laneId, "refresh", reserveUsd(cfg));
    const provider = p.provider;
    const now = new Date();
    after(async () => {
      try {
        const res = await runNewsFetch(
          {
            provider,
            begin: () => Promise.resolve(id),
            finish: (attempt, r) => finishNews(client, laneId, "refresh", attempt, r),
            signal: AbortSignal.timeout(NEWS_FETCH_TIMEOUT_MS),
            retryOnlyBeforeMs: NEWS_RETRY_BEFORE_MS,
          },
          { laneId, laneName, cfg, now },
        );
        console.info("[news] refresh finished", { laneId, status: res.status, failure: res.failureCode });
      } catch (e) {
        // The row stays pending; SQL closes it as lost after 10 minutes (its reserved cost is kept). Class only, never detail.
        console.error("[news] refresh run failed", { laneId, error: e instanceof Error ? e.name : typeof e });
      }
    });
    revalidatePath(`/${laneId}`);
    return { ok: true, status: "started" };
  } catch (e) {
    if (e instanceof AuthError) return { error: "forbidden" };
    if (e instanceof NewsGateError) return { error: e.code === "already_fetched" || e.code === "retry_later" || e.code === "attempts_exhausted" ? "busy" : e.code };
    if (e instanceof Error && e.name === "EnvValidationError") return { error: "ai_not_set_up" };
    console.error("[news] refresh failed", { laneId, error: e instanceof Error ? e.name : typeof e });
    return { error: "unavailable" };
  }
}
