// The only file that talks to the Anthropic SDK. Request shape follows the current API rules:
// adaptive thinking or none (never `disabled`, never budget_tokens), no sampling parameters, tool_choice auto only,
// effort via output_config, no assistant prefill.
import Anthropic from "@anthropic-ai/sdk";
import { LLMProviderError } from "./types";
import type {
  LLMCallLog,
  LLMContentBlock,
  LLMErrorCode,
  LLMLogger,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResult,
  LLMUsage,
  ModelTier,
} from "./types";

/** Above this, long calls risk HTTP timeouts: stream and take the final message. */
export const STREAM_ABOVE_MAX_TOKENS = 16_000;

type Params = Anthropic.MessageCreateParamsNonStreaming;
type Msg = Anthropic.Message;

/** The slice of the SDK client that this provider uses; tests pass a fake. */
export interface AnthropicLike {
  messages: {
    create(params: Params, options?: { signal?: AbortSignal }): PromiseLike<Msg>;
    stream(params: Params, options?: { signal?: AbortSignal }): { finalMessage(): Promise<Msg> };
  };
}

export type AnthropicProviderOptions = {
  apiKey?: string;
  models: Record<ModelTier, string>;
  logger?: LLMLogger;
  client?: AnthropicLike;
  /** SDK retries for 429/5xx/connection errors. Default 2. */
  maxRetries?: number;
};

const DEFAULT_LOGGER: LLMLogger = (entry) => {
  // Structured metadata only: LLMCallLog cannot carry prompt or completion text.
  console.info(JSON.stringify({ event: "llm.call", ...entry }));
};

function toBlock(b: LLMContentBlock): Anthropic.ContentBlockParam {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) };
    case "thinking":
      return { type: "thinking", thinking: b.thinking, signature: b.signature };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: b.data };
  }
}

function toMessage(m: LLMMessage): Anthropic.MessageParam {
  return { role: m.role, content: typeof m.content === "string" ? m.content : m.content.map(toBlock) };
}

/** Pure request builder (exported for tests). Throws invalid_request for combinations the API rejects. */
export function buildParams(req: LLMRequest, model: string): Params {
  if (req.messages.length === 0 || req.messages[req.messages.length - 1]?.role !== "user") {
    throw new LLMProviderError("invalid_request"); // assistant prefill is not supported
  }
  if (req.thinking === "off" && (req.effort === "xhigh" || req.effort === "max")) {
    throw new LLMProviderError("invalid_request"); // thinking-off is only valid at effort <= high
  }
  const params: Params = {
    model,
    max_tokens: req.maxTokens,
    messages: req.messages.map(toMessage),
  };
  if (req.system) params.system = req.system;
  if (req.thinking === "adaptive") params.thinking = { type: "adaptive" };
  else if (req.thinking === "off") params.thinking = { type: "between_tools" };
  if (req.effort) params.output_config = { effort: req.effort };
  if (req.tools?.length) {
    params.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { ...t.inputSchema, type: "object" } as Anthropic.Tool.InputSchema,
    }));
    params.tool_choice = { type: "auto" };
  }
  return params;
}

function mapUsage(u: Msg["usage"]): LLMUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function mapContent(blocks: Msg["content"]): LLMContentBlock[] {
  const out: LLMContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    else if (b.type === "thinking") out.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
    else if (b.type === "redacted_thinking") out.push({ type: "redacted_thinking", data: b.data });
    // Other server-side block kinds are not requested, so they are not surfaced.
  }
  return out;
}

export function mapMessage(m: Msg, latencyMs: number): LLMResult {
  const common = {
    content: mapContent(m.content),
    usage: mapUsage(m.usage),
    model: m.model,
    requestId: (m as { _request_id?: string | null })._request_id ?? null,
    latencyMs,
  };
  switch (m.stop_reason) {
    case "refusal":
      return { ...common, status: "refused", stopReason: "refusal", refusal: { category: m.stop_details?.category ?? null } };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { ...common, status: "max_tokens", stopReason: m.stop_reason };
    case "tool_use":
      return { ...common, status: "tool_use", stopReason: "tool_use" };
    case "pause_turn":
      return { ...common, status: "paused", stopReason: "pause_turn" };
    default:
      return { ...common, status: "completed", stopReason: m.stop_reason === "stop_sequence" ? "stop_sequence" : "end_turn" };
  }
}

/** Typed-error mapping (instanceof only; never message matching). */
export function mapError(err: unknown): LLMProviderError {
  if (err instanceof LLMProviderError) return err;
  const api = err instanceof Anthropic.APIError ? err : null;
  const requestId = api?.requestID ?? null;
  const status = api?.status ?? null;
  let code: LLMErrorCode = "unknown";
  if (err instanceof Anthropic.APIUserAbortError) code = "aborted";
  else if (err instanceof Anthropic.APIConnectionTimeoutError) code = "timeout";
  else if (err instanceof Anthropic.APIConnectionError) code = "connection";
  else if (err instanceof Anthropic.RateLimitError) code = "rate_limited";
  else if (err instanceof Anthropic.OverloadedError || err instanceof Anthropic.ServiceUnavailableError) code = "overloaded";
  else if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) code = "unauthorized";
  else if (err instanceof Anthropic.RequestTimeoutError || err instanceof Anthropic.GatewayTimeoutError) code = "timeout";
  else if (err instanceof Anthropic.InternalServerError) code = "server_error";
  else if (api && status !== null && status >= 400 && status < 500) code = "invalid_request";
  return new LLMProviderError(code, { status, requestId });
}

export function createAnthropicProvider(opts: AnthropicProviderOptions): LLMProvider {
  const logger = opts.logger ?? DEFAULT_LOGGER;
  let client = opts.client;
  const getClient = (): AnthropicLike => {
    if (!client) {
      if (!opts.apiKey) throw new LLMProviderError("unauthorized");
      client = new Anthropic({ apiKey: opts.apiKey, maxRetries: opts.maxRetries ?? 2 }) as unknown as AnthropicLike;
    }
    return client;
  };
  const modelFor = (tier: ModelTier) => opts.models[tier];

  return {
    name: "anthropic",
    modelFor,
    async complete(req) {
      const model = modelFor(req.tier);
      const started = Date.now();
      const log = (p: Partial<LLMCallLog>) =>
        logger({
          laneId: req.laneId,
          model,
          tier: req.tier,
          outcome: "ok",
          stopReason: null,
          errorCode: null,
          usage: null,
          latencyMs: Date.now() - started,
          requestId: null,
          ...p,
        });
      try {
        if (!req.laneId) throw new LLMProviderError("invalid_request");
        const params = buildParams(req, model);
        const c = getClient();
        const options = req.signal ? { signal: req.signal } : undefined;
        const message =
          req.stream || req.maxTokens > STREAM_ABOVE_MAX_TOKENS
            ? await c.messages.stream(params, options).finalMessage()
            : await c.messages.create(params, options);
        const result = mapMessage(message, Date.now() - started);
        log({ stopReason: result.stopReason, usage: result.usage, requestId: result.requestId, model: result.model });
        return result;
      } catch (err) {
        const e = mapError(err);
        log({ outcome: "error", errorCode: e.code, requestId: e.requestId });
        throw e;
      }
    },
  };
}
