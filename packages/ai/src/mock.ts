// Deterministic provider for tests: no network, no key. Records calls (including prompts; it only lives in tests).
import { LLMProviderError } from "./types";
import type { LLMContentBlock, LLMProvider, LLMRequest, LLMResult, ModelTier } from "./types";

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
      if (!req.laneId) throw new LLMProviderError("invalid_request");
      calls.push(req);
      const next: MockReply = replies[Math.min(i++, replies.length - 1)] ?? textResult("mock");
      const r = typeof next === "function" ? next(req) : next;
      if (r instanceof LLMProviderError) throw r;
      return { ...r, model: models[req.tier] };
    },
  };
}
