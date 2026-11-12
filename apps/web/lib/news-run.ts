// One GovCon news fetch (T-234 part 4). Order, and why:
//   1. begin(reserve): the SQL gates (web category, news.enabled, once a day / 1 per hour, monthly cap, one in flight) run and
//      the worst-case cost is reserved BEFORE any model call. A refusal is a NewsGateError (nothing stored, no model call).
//   2. one model call on the "analysis" tier with the server-side web search tool and NO Jarvis tools, NO lane data (plan-review 11).
//   3. the answer is validated (news-domain: grounded https links, 48 h, plain text); only then is it stored.
//   4. finish(...) stores the items (or a fixed failure code) and the cost estimate, replacing the reserve.
// The model's text is never stored as written and never reaches any prompt again. Nothing here writes to an external system.
import { LLMProviderError, type LLMProvider } from "@nichols/ai";
import {
  actualUsd,
  buildNewsSystem,
  buildNewsUser,
  collectEvidence,
  newsJsonFrom,
  NEWS_MAX_RESUMES,
  NEWS_MAX_TOKENS,
  NEWS_MIN_OK_ITEMS,
  reserveUsd,
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
};

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
  let result;
  try {
    result = await deps.provider.complete({
      laneId: input.laneId as never,
      tier: "analysis",
      system: buildNewsSystem({ laneName: input.laneName, cfg, now }),
      messages: [{ role: "user", content: buildNewsUser(now) }],
      maxTokens: NEWS_MAX_TOKENS,
      serverTools: { webSearch: { maxUses: cfg.max_searches, maxResumes: NEWS_MAX_RESUMES, ...(cfg.blocked_domains.length ? { blockedDomains: cfg.blocked_domains } : {}) } },
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } catch (e) {
    const f = failureFor(e);
    // Once any model call completed (a search that paused and was resumed, then failed), the cost is the reserve floor or what the
    // provider saw, whichever is higher: never $0 after a call ran.
    const used = e instanceof LLMProviderError ? e.usage : undefined;
    const estimate = f.cost === "zero" && !used ? 0 : Math.max(reserve, used ? actualUsd(used, cfg) : 0);
    return failed(f.code, estimate, Math.min(50, used?.webSearchRequests ?? 0));
  }
  const cost = actualUsd(result.usage, cfg); // the honest estimate replaces the reserve, even when it is higher
  const searches = Math.min(50, result.usage.webSearchRequests ?? 0);
  if (result.status === "refused") return failed("model_refused", cost, searches);
  if (result.status === "paused") return failed("incomplete", cost, searches);
  if (result.status !== "completed") return failed("output_unusable", cost, searches);
  const evidence = collectEvidence(result);
  if (evidence.searchOk === 0 && evidence.searchErrors > 0) return failed("search_failed", cost, searches);
  const json = newsJsonFrom(result.content);
  if (json === null) return failed("output_unusable", cost, searches);
  const { items } = validateNews(json, evidence, cfg, now);
  if (items.length === 0) return failed("no_valid_items", cost, searches);
  return done({ status: items.length >= NEWS_MIN_OK_ITEMS ? "ok" : "partial", failureCode: null, items, searches, estCostUsd: cost });
}
