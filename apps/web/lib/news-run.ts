// One GovCon news fetch (T-234 part 4). Order, and why:
//   1. begin(reserve): the SQL gates (web category, news.enabled, once a day / 1 per hour, monthly cap, one in flight) run and
//      the worst-case cost is reserved BEFORE any model call. A refusal is a NewsGateError (nothing stored, no model call).
//   2. one model call on the "analysis" tier with the server-side web search tool and NO Jarvis tools, NO lane data (plan-review 11).
//      Its output limit is lane_config news.max_tokens (T-236). A reply cut off at that limit (stopReason max_tokens) is NEVER
//      parsed: it is retried once with 1.5x the limit and fewer, shorter stories, when the time bound still allows it; a second
//      cut-off reply is recorded as output_truncated. The cost of both calls is counted.
//   3. the answer is validated (news-domain: grounded https links, 48 h, plain text); a bad story is dropped on its own, and the
//      fetch fails only when no story is left. Only then is anything stored.
//   Logs carry codes and counts only (stopReason, output tokens, searches, drop reasons): never a headline, a link or the reply.
//   4. finish(...) stores the items (or a fixed failure code) and the cost estimate, replacing the reserve.
// The model's text is never stored as written and never reaches any prompt again. Nothing here writes to an external system.
import { LLMProviderError, type LLMProvider, type LLMResult } from "@nichols/ai";
import {
  actualUsd,
  buildNewsSystem,
  buildNewsUser,
  collectEvidence,
  newsJsonFrom,
  NEWS_MAX_RESUMES,
  NEWS_MIN_OK_ITEMS,
  reserveUsd,
  retryMaxTokens,
  validateNews,
  type NewsConfig,
} from "./news-domain";
import { NEWS_GATE_CODES, type NewsFailureCode, type NewsGateCode, type StoredNewsItem } from "./news-types";

export class NewsGateError extends Error {
  readonly code: NewsGateCode;
  constructor(code: NewsGateCode) {
    super(`news refused: ${code}`);
    this.name = "NewsGateError";
    this.code = code;
  }
}

export type NewsFinish = { status: "ok" | "partial" | "failed"; failureCode: NewsFailureCode | null; items: StoredNewsItem[]; searches: number; estCostUsd: number };

export type NewsRunDeps = {
  provider: LLMProvider;
  /** Reserves the attempt (SQL gates + cap). Throws NewsGateError with a gate code, or another error for infrastructure faults. */
  begin: (reserveUsd: number) => Promise<string>;
  finish: (id: string, r: NewsFinish) => Promise<void>;
  /** Aborts the model call (the Refresh time bound). */
  signal?: AbortSignal;
  /** Milliseconds clock (tests only); default Date.now. Used for the retry budget. */
  clock?: () => number;
};

/** No retry after a cut-off reply once this much of the fetch has elapsed: it could not finish inside the Refresh bound (70 s). */
export const NEWS_RETRY_ONLY_BEFORE_MS = 30_000;

type Usage = LLMResult["usage"];
const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  webSearchRequests: (a.webSearchRequests ?? 0) + (b.webSearchRequests ?? 0),
});

export type NewsRunResult = { id: string; status: NewsFinish["status"]; failureCode: NewsFailureCode | null; items: number };

/** Maps the gate text returned by core.news_begin_* / brief.news_reserve ({id, gate}) to a gate code; anything else is null. */
export function gateCodeFrom(gate: unknown): NewsGateCode | null {
  return typeof gate === "string" ? (NEWS_GATE_CODES.find((c) => gate === c) ?? null) : null;
}

function failureFor(e: unknown): { code: NewsFailureCode; cost: "reserve" | "zero" } {
  if (e instanceof LLMProviderError) {
    if (e.code === "rate_limited" || e.code === "overloaded") return { code: "model_busy", cost: "zero" };
    if (e.code === "timeout" || e.code === "aborted") return { code: "timed_out", cost: "reserve" };
    if (e.code === "unauthorized" || e.code === "invalid_request") return { code: "model_failed", cost: "zero" };
    return { code: "model_failed", cost: "reserve" };
  }
  return { code: "model_failed", cost: "reserve" };
}

export async function runNewsFetch(deps: NewsRunDeps, input: { laneId: string; laneName: string; cfg: NewsConfig; now: Date }): Promise<NewsRunResult> {
  const { cfg, now } = input;
  const reserve = reserveUsd(cfg);
  const id = await deps.begin(reserve);
  const done = async (r: NewsFinish): Promise<NewsRunResult> => {
    try {
      await deps.finish(id, r);
      return { id, status: r.status, failureCode: r.failureCode, items: r.items.length };
    } catch (e) {
      if (r.status === "failed") throw e;
      // The database refused the items (its own shape check): close the attempt as failed, keeping the cost, so it is not left pending.
      const fallback: NewsFinish = { status: "failed", failureCode: "output_unusable", items: [], searches: r.searches, estCostUsd: r.estCostUsd };
      await deps.finish(id, fallback);
      return { id, status: "failed", failureCode: "output_unusable", items: 0 };
    }
  };
  const failed = (code: NewsFailureCode, estCostUsd: number, searches = 0) => done({ status: "failed", failureCode: code, items: [], searches, estCostUsd });
  const clock = deps.clock ?? Date.now;
  const startedMs = clock();
  const ask = (retry: boolean) =>
    deps.provider.complete({
      laneId: input.laneId as never,
      tier: "analysis",
      system: buildNewsSystem({ laneName: input.laneName, cfg, now, retry }),
      messages: [{ role: "user", content: buildNewsUser(now) }],
      maxTokens: retry ? retryMaxTokens(cfg) : cfg.max_tokens,
      // The retry after a cut-off reply runs at effort "low" (less thinking: fewer tokens and a shorter call). Best effort: it
      // starts only in the first 30 s and the Refresh bound (70 s) still applies.
      ...(retry ? { effort: "low" as const } : {}),
      serverTools: { webSearch: { maxUses: cfg.max_searches, maxResumes: NEWS_MAX_RESUMES, ...(cfg.blocked_domains.length ? { blockedDomains: cfg.blocked_domains } : {}) } },
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  // Codes and counts only (never content).
  const logCall = (attempt: number, r: LLMResult, maxTokens: number) =>
    console.info("[news] news.model_call", { laneId: input.laneId, attempt, stopReason: r.stopReason, outputTokens: r.usage.outputTokens, maxTokens, searches: r.usage.webSearchRequests ?? 0 });
  let result: LLMResult;
  let spent: Usage | undefined; // the usage of a first, cut-off call (counted in the cost even when the retry fails)
  try {
    result = await ask(false);
    logCall(1, result, cfg.max_tokens);
    if (result.status === "max_tokens" && result.stopReason === "max_tokens") {
      // Never parse a truncated reply. One retry with a higher limit and fewer stories, only while it can still finish in time.
      spent = result.usage;
      if (clock() - startedMs > NEWS_RETRY_ONLY_BEFORE_MS) {
        console.error("[news] news.retry_skipped", { laneId: input.laneId, elapsedMs: clock() - startedMs });
      } else {
        const second = await ask(true);
        logCall(2, second, retryMaxTokens(cfg));
        result = { ...second, usage: addUsage(spent, second.usage) };
        spent = undefined;
      }
    }
  } catch (e) {
    const f = failureFor(e);
    // Once any model call completed (a first cut-off call, or a search that paused and was resumed, then failed), the cost is the
    // reserve floor or what the provider saw, whichever is higher: never $0 after a call ran.
    const thrown = e instanceof LLMProviderError ? e.usage : undefined;
    const used = spent && thrown ? addUsage(spent, thrown) : (spent ?? thrown);
    const estimate = f.cost === "zero" && !used ? 0 : Math.max(reserve, used ? actualUsd(used, cfg) : 0);
    console.error("[news] news.model_failed", { laneId: input.laneId, code: f.code });
    return failed(f.code, estimate, Math.min(50, used?.webSearchRequests ?? 0));
  }
  const cost = actualUsd(result.usage, cfg); // the honest estimate replaces the reserve, even when it is higher
  const searches = Math.min(50, result.usage.webSearchRequests ?? 0);
  if (result.status === "refused") return failed("model_refused", cost, searches);
  if (result.status === "paused") return failed("incomplete", cost, searches);
  if (result.status === "max_tokens") return failed("output_truncated", cost, searches);
  if (result.status !== "completed") return failed("output_unusable", cost, searches);
  const evidence = collectEvidence(result);
  if (evidence.searchOk === 0 && evidence.searchErrors > 0) return failed("search_failed", cost, searches);
  const json = newsJsonFrom(result.content);
  if (json === null) {
    console.error("[news] news.output_unusable", { laneId: input.laneId, stopReason: result.stopReason, outputTokens: result.usage.outputTokens });
    return failed("output_unusable", cost, searches);
  }
  const { items, dropped, reasons } = validateNews(json, evidence, cfg, now);
  console.info("[news] news.validated", { laneId: input.laneId, kept: items.length, dropped, reasons });
  if (items.length === 0) return failed("no_valid_items", cost, searches);
  return done({ status: items.length >= NEWS_MIN_OK_ITEMS ? "ok" : "partial", failureCode: null, items, searches, estCostUsd: cost });
}
