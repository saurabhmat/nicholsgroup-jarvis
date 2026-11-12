// Deterministic provider for tests: no network, no key. Records calls (including prompts), so it is exported only
// from `@nichols/ai/testing`, which lint allows in test files only.
import { buildParams } from "./anthropic";
import { LLMProviderError } from "./types";
import type { LLMCitation, LLMContentBlock, LLMProvider, LLMRequest, LLMResult, LLMWebSearchHit, ModelTier } from "./types";

export type MockReply = LLMResult | LLMProviderError | ((req: LLMRequest) => LLMResult | LLMProviderError);

export interface MockLLMProvider extends LLMProvider {
  readonly calls: LLMRequest[];
}

export function textResult(text: string, over: Partial<Extract<LLMResult, { status: "completed" }>> = {}): LLMResult {
  const content: LLMContentBlock[] = [{ type: "text", text }];
  return {
    status: "completed",
    stopReason: "end_turn",
    content,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    model: "mock",
    requestId: "req_mock",
    latencyMs: 0,
    ...over,
  };
}

/** A completed reply whose text is the JSON of `value` (what a structured-output request returns). */
export const jsonResult = (value: unknown): LLMResult => textResult(JSON.stringify(value));

/**
 * A completed web-search reply: one search, its hits (or an error object), then the answer text with citations. Search
 * results and citations are shaped exactly like the real provider's output for a request that opted in.
 */
export function webSearchResult(opts: {
  text: string;
  hits?: { url: string; title?: string; pageAge?: string | null }[];
  citations?: { url: string; title?: string | null; citedText?: string }[];
  errorCode?: string;
  searches?: number;
}): LLMResult {
  const results: LLMWebSearchHit[] | null = opts.errorCode ? null : (opts.hits ?? []).map((h) => ({ url: h.url, title: h.title ?? "Title", pageAge: h.pageAge ?? null, encryptedContent: "enc" }));
  const citations: LLMCitation[] = (opts.citations ?? []).map((c) => ({ url: c.url, title: c.title ?? null, citedText: c.citedText ?? "cited", encryptedIndex: "idx" }));
  const content: LLMContentBlock[] = [
    { type: "server_tool_use", id: "srvtoolu_mock", name: "web_search", input: { query: "mock" } },
    { type: "web_search_tool_result", toolUseId: "srvtoolu_mock", results, errorCode: opts.errorCode ?? null },
    { type: "text", text: opts.text, ...(citations.length ? { citations } : {}) },
  ];
  return textResult(opts.text, { content, usage: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: opts.searches ?? 1 } });
}

const hasServerBlock = (r: LLMResult) => r.content.some((b) => b.type === "server_tool_use" || b.type === "web_search_tool_result" || (b.type === "text" && !!b.citations?.length));

/** Replies are consumed in order; the last one repeats. With no replies it answers "mock". */
export function createMockProvider(
  replies: MockReply[] = [],
  models: Record<ModelTier, string> = { analysis: "mock-analysis", fast: "mock-fast" },
): MockLLMProvider {
  const calls: LLMRequest[] = [];
  let i = 0;
  return {
    name: "mock",
    calls,
    modelFor: (tier) => models[tier],
    async complete(req) {
      // Same request validation as the real provider, so tests cannot pass with requests the API would reject.
      buildParams(req, models[req.tier]);
      calls.push(structuredClone({ ...req, signal: undefined }));
      const next: MockReply = replies[Math.min(i++, replies.length - 1)] ?? textResult("mock");
      const r = typeof next === "function" ? next(req) : next;
      if (r instanceof LLMProviderError) throw r;
      // Same fail-closed rule as the real provider: a server-side block without the opt-in is drift.
      if (!req.serverTools?.webSearch && hasServerBlock(r)) throw new LLMProviderError("unknown");
      return { ...r, model: models[req.tier] };
    },
  };
}
