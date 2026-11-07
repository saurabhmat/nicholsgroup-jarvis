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

export type LLMContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  /** Opaque: pass back unchanged and in order when continuing a tool loop. */
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export type LLMMessage = { role: "user" | "assistant"; content: string | LLMContentBlock[] };

export type LLMTool = {
  name: string;
  description: string;
  /** JSON Schema object for the tool input. */
  inputSchema: Record<string, unknown>;
};

export type LLMRequest = {
  laneId: LaneId;
  tier: ModelTier;
  system?: string;
  /** The last message must be a user message (no assistant prefill). */
  messages: LLMMessage[];
  maxTokens: number;
  effort?: Effort;
  thinking?: ThinkingMode;
  /** Tool choice is always automatic: forced tool use is not supported by the current models. */
  tools?: LLMTool[];
  /** Force streaming. Streaming is used automatically for large maxTokens. */
  stream?: boolean;
  signal?: AbortSignal;
};

export type LLMUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
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
  constructor(code: LLMErrorCode, opts: { status?: number | null; requestId?: string | null } = {}) {
    // The message is a fixed string per code: vendor error bodies can echo prompt text, so they are never copied.
    super(`LLM provider error: ${code}`);
    this.name = "LLMProviderError";
    this.code = code;
    this.status = opts.status ?? null;
    this.requestId = opts.requestId ?? null;
    this.retryable =
      code === "rate_limited" || code === "overloaded" || code === "timeout" || code === "connection" || code === "server_error";
  }
}
