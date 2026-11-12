// Provider-neutral LLM contract. Nothing outside packages/ai imports a vendor SDK; callers depend on this file only.
// Rule 1: every call takes laneId. Rule 9: retrieved content is data, so the interface has no way to force a tool.
import type { LaneId } from "@nichols/core";

/** "analysis" = the stronger model (reasoning, drafting); "fast" = the cheap model (classify, extract, route). */
export type ModelTier = "analysis" | "fast";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
/**
 * "omit" (default) sends no thinking field. "adaptive" lets the model decide. "off" means thinking off between tools
 * (`between_tools`, valid at effort up to "high"). The vendor `disabled` and `budget_tokens` forms are never sent.
 */
export type ThinkingMode = "omit" | "adaptive" | "off";

/** Prompt-cache breakpoint. "5m" is the vendor default; "1h" costs more to write but survives longer. */
export type CacheTtl = "5m" | "1h";

/** One citation on a text block (web search only). `encryptedIndex` is opaque: it is passed back unchanged on a resume. */
export type LLMCitation = { url: string; title: string | null; citedText: string; encryptedIndex: string };

/** One web search hit. `encryptedContent` is opaque (never read, only passed back on a resume). */
export type LLMWebSearchHit = { url: string; title: string; pageAge: string | null; encryptedContent: string };

export type LLMContentBlock =
  | { type: "text"; text: string; cache?: CacheTtl; /** Only present on results of a call that opted in to web search. */ citations?: LLMCitation[] }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  /** Must come first in the user turn that follows the assistant tool_use, one per tool_use id. */
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean; cache?: CacheTtl }
  /** Opaque: pass back unchanged and in order when continuing a tool loop. */
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  /**
   * Web search blocks exist only for a request with `serverTools.webSearch` (an explicit opt-in). Without it the provider
   * refuses to send or accept them. Search results are UNTRUSTED data (rule 9): callers validate before use.
   */
  | { type: "server_tool_use"; id: string; name: "web_search"; input: unknown }
  /** `results` on success; `errorCode` (and `results` null) when the search failed: the API answers 200 with an error object. */
  | { type: "web_search_tool_result"; toolUseId: string; results: LLMWebSearchHit[] | null; errorCode: string | null };

export type LLMMessage = { role: "user" | "assistant"; content: string | LLMContentBlock[] };

export type LLMTool = {
  name: string;
  description: string;
  /** JSON Schema object for the tool input. */
  inputSchema: Record<string, unknown>;
  /** Cache breakpoint after this tool definition (put it on the last tool to cache the whole tool list). */
  cache?: CacheTtl;
};

/** System prompt as blocks so a stable prefix can be cached. Untrusted content never goes in the system prompt. */
export type LLMSystemBlock = { text: string; cache?: CacheTtl };

/**
 * Explicit opt-in to Anthropic's server-side web search (rule 9: results are untrusted). `allowedDomains` and
 * `blockedDomains` are mutually exclusive plain hostnames (at most 64 each). Not combinable with client `tools`.
 * A `pause_turn` is resumed inside the provider (assistant content re-sent, no extra user message) at most `maxResumes`
 * times (default 2); the result then carries every block and the summed usage.
 */
export type LLMWebSearch = { maxUses: number; allowedDomains?: string[]; blockedDomains?: string[]; maxResumes?: number };
export type LLMServerTools = { webSearch?: LLMWebSearch };

export type LLMRequest = {
  laneId: LaneId;
  tier: ModelTier;
  system?: string | LLMSystemBlock[];
  /** The last message must be a user message (no assistant prefill). */
  messages: LLMMessage[];
  /** Integer, 1..MAX_TOKENS_CEILING. */
  maxTokens: number;
  /** Per-attempt timeout; default from the provider (2 minutes). */
  timeoutMs?: number;
  effort?: Effort;
  thinking?: ThinkingMode;
  /** Tool choice is always automatic: forced tool use is not supported by the current models. */
  tools?: LLMTool[];
  /** Server-side tools, off unless set. Without it a server-side block in a reply fails closed. */
  serverTools?: LLMServerTools;
  /** Force streaming. Streaming is used automatically for large maxTokens. */
  stream?: boolean;
  signal?: AbortSignal;
};

export type LLMUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Searches billed (`usage.server_tool_use.web_search_requests`); absent when the call used no server tool. */
  webSearchRequests?: number;
};

export type RefusalCategory = "cyber" | "bio" | "frontier_llm" | "reasoning_extraction" | "general_harms" | null;

type Common = {
  content: LLMContentBlock[];
  usage: LLMUsage;
  model: string;
  requestId: string | null;
  latencyMs: number;
};

/** A typed outcome: refusals and truncation are results, not exceptions. Transport/API failures throw LLMProviderError. */
export type LLMResult =
  | (Common & { status: "completed"; stopReason: "end_turn" | "stop_sequence" })
  | (Common & { status: "tool_use"; stopReason: "tool_use" })
  | (Common & { status: "max_tokens"; stopReason: "max_tokens" | "model_context_window_exceeded" })
  | (Common & { status: "paused"; stopReason: "pause_turn" })
  | (Common & { status: "refused"; stopReason: "refusal"; refusal: { category: RefusalCategory } });

export interface LLMProvider {
  readonly name: string;
  /** The model id configured for a tier (from env, never hard-coded). */
  modelFor(tier: ModelTier): string;
  complete(request: LLMRequest): Promise<LLMResult>;
}

export type LLMErrorCode =
  | "rate_limited"
  | "overloaded"
  | "unauthorized"
  | "invalid_request"
  | "timeout"
  | "connection"
  | "aborted"
  | "server_error"
  | "unknown";

/**
 * One log entry per call. Deliberately has no field that can hold prompt or completion text; the logger is handed
 * exactly this object and nothing else.
 */
export type LLMCallLog = {
  laneId: LaneId;
  model: string;
  tier: ModelTier;
  outcome: "ok" | "error";
  stopReason: string | null;
  errorCode: LLMErrorCode | null;
  usage: LLMUsage | null;
  latencyMs: number;
  requestId: string | null;
};
export type LLMLogger = (entry: LLMCallLog) => void;

export class LLMProviderError extends Error {
  readonly code: LLMErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly requestId: string | null;
  /**
   * Usage of the calls that DID complete before this failure (a web-search request that paused and was resumed, then failed):
   * a lower bound on what was billed, for cost accounting. Absent when no call completed.
   */
  usage?: LLMUsage;
  constructor(code: LLMErrorCode, opts: { status?: number | null; requestId?: string | null; usage?: LLMUsage } = {}) {
    // The message is a fixed string per code: vendor error bodies can echo prompt text, so they are never copied.
    super(`LLM provider error: ${code}`);
    this.name = "LLMProviderError";
    this.code = code;
    this.status = opts.status ?? null;
    this.requestId = opts.requestId ?? null;
    if (opts.usage) this.usage = opts.usage;
    this.retryable =
      code === "rate_limited" || code === "overloaded" || code === "timeout" || code === "connection" || code === "server_error";
  }
}
