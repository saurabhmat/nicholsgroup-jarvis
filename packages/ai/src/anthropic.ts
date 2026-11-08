// The only file that talks to the Anthropic SDK. Request shape follows the current API rules:
// adaptive thinking or none (never `disabled`, never budget_tokens), no sampling parameters, tool_choice auto only,
// effort via output_config, no assistant prefill.
import "server-only";
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
  CacheTtl,
  ModelTier,
} from "./types";

/** Above this, long calls risk HTTP timeouts: stream and take the final message. */
export const STREAM_ABOVE_MAX_TOKENS = 16_000;
/** Hard ceiling on maxTokens per call (cost guard). */
export const MAX_TOKENS_CEILING = 64_000;
/** Default per-attempt timeout. The SDK default (10 minutes) is far too long for a request path. */
export const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Same lane-code format as core (lane-router LANE_ID). */
const LANE_ID = /^[A-Z]{1,8}$/;

type Params = Anthropic.MessageCreateParamsNonStreaming;
type Msg = Anthropic.Message;
type RequestOpts = { signal?: AbortSignal; timeout?: number };

/** The slice of the SDK client that this provider uses; tests pass a fake. */
export interface AnthropicLike {
  messages: {
    create(params: Params, options?: RequestOpts): PromiseLike<Msg>;
    stream(params: Params, options?: RequestOpts): { finalMessage(): Promise<Msg>; readonly request_id?: string | null | undefined };
  };
}

export type AnthropicProviderOptions = {
  apiKey?: string;
  models: Record<ModelTier, string>;
  logger?: LLMLogger;
  client?: AnthropicLike;
  /**
   * SDK retries for 429/5xx/connection errors. Default 2. Callers must not add their own retries on top; inside an
   * Inngest step pass 0 and let the step retry policy own it.
   */
  maxRetries?: number;
  /** Default per-attempt timeout (ms). Default DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
};

const DEFAULT_LOGGER: LLMLogger = (entry) => {
  // Structured metadata only: LLMCallLog cannot carry prompt or completion text.
  console.info(JSON.stringify({ event: "llm.call", ...entry }));
};

function cacheControl(ttl: CacheTtl | undefined): { cache_control?: Anthropic.CacheControlEphemeral } {
  return ttl ? { cache_control: ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" } } : {};
}

function toBlock(b: LLMContentBlock): Anthropic.ContentBlockParam {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text, ...cacheControl(b.cache) };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: b.content,
        ...(b.isError ? { is_error: true } : {}),
        ...cacheControl(b.cache),
      };
    case "thinking":
      return { type: "thinking", thinking: b.thinking, signature: b.signature };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: b.data };
  }
}

function toMessage(m: LLMMessage): Anthropic.MessageParam {
  return { role: m.role, content: typeof m.content === "string" ? m.content : m.content.map(toBlock) };
}

const blocksOf = (m: LLMMessage | undefined): LLMContentBlock[] => (!m || typeof m.content === "string" ? [] : m.content);

/**
 * Tool loop shape: each user turn that answers an assistant tool_use starts with exactly one tool_result per tool_use
 * id (no strays, no duplicates, nothing before them); a user turn with tool_results must follow such an assistant turn.
 */
function validateToolRoundTrips(messages: LLMMessage[]): void {
  messages.forEach((m, i) => {
    const blocks = blocksOf(m);
    if (m.role === "assistant") {
      if (blocks.some((b) => b.type === "tool_result")) throw new LLMProviderError("invalid_request");
      return;
    }
    const prevIds = blocksOf(messages[i - 1])
      .filter((b) => b.type === "tool_use")
      .map((b) => (b as { id: string }).id);
    const resultIdx = blocks.flatMap((b, j) => (b.type === "tool_result" ? [j] : []));
    if (blocks.some((b) => b.type === "tool_use" || b.type === "thinking" || b.type === "redacted_thinking")) {
      throw new LLMProviderError("invalid_request");
    }
    if (prevIds.length === 0) {
      if (resultIdx.length > 0) throw new LLMProviderError("invalid_request");
      return;
    }
    // Results first, contiguous, and the id sets match exactly.
    if (resultIdx.some((j, k) => j !== k)) throw new LLMProviderError("invalid_request");
    const ids = resultIdx.map((j) => (blocks[j] as { toolUseId: string }).toolUseId);
    if (ids.length !== prevIds.length || new Set(ids).size !== ids.length || ids.some((id) => !prevIds.includes(id))) {
      throw new LLMProviderError("invalid_request");
    }
  });
}

/** Pure request builder (exported for tests). Throws invalid_request for combinations the API rejects. */
export function buildParams(req: LLMRequest, model: string): Params {
  if (typeof req.laneId !== "string" || !LANE_ID.test(req.laneId)) throw new LLMProviderError("invalid_request");
  if (!Number.isInteger(req.maxTokens) || req.maxTokens < 1 || req.maxTokens > MAX_TOKENS_CEILING) {
    throw new LLMProviderError("invalid_request");
  }
  if (req.timeoutMs !== undefined && (!Number.isInteger(req.timeoutMs) || req.timeoutMs < 1 || req.timeoutMs > MAX_TIMEOUT_MS)) {
    throw new LLMProviderError("invalid_request");
  }
  if (req.messages.length === 0 || req.messages[req.messages.length - 1]?.role !== "user") {
    throw new LLMProviderError("invalid_request"); // assistant prefill is not supported
  }
  if (req.thinking === "off" && (req.effort === "xhigh" || req.effort === "max")) {
    throw new LLMProviderError("invalid_request"); // thinking-off is only valid at effort <= high
  }
  validateToolRoundTrips(req.messages);
  const params: Params = {
    model,
    max_tokens: req.maxTokens,
    messages: req.messages.map(toMessage),
  };
  if (typeof req.system === "string") {
    if (req.system) params.system = req.system;
  } else if (req.system?.length) {
    params.system = req.system.map((b) => ({ type: "text" as const, text: b.text, ...cacheControl(b.cache) }));
  }
  if (req.thinking === "adaptive") params.thinking = { type: "adaptive" };
  else if (req.thinking === "off") params.thinking = { type: "between_tools" };
  if (req.effort) params.output_config = { effort: req.effort };
  if (req.tools?.length) {
    params.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { ...t.inputSchema, type: "object" } as Anthropic.Tool.InputSchema,
      ...cacheControl(t.cache),
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
    // Server-side block kinds are never requested (no server tools), so one arriving means drift: fail closed.
    else throw new LLMProviderError("unknown");
  }
  return out;
}

export function mapMessage(m: Msg, latencyMs: number, requestId?: string | null): LLMResult {
  const common = {
    content: mapContent(m.content),
    usage: mapUsage(m.usage),
    model: m.model,
    requestId: requestId ?? (m as { _request_id?: string | null })._request_id ?? null,
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
    case "end_turn":
    case "stop_sequence":
      return { ...common, status: "completed", stopReason: m.stop_reason };
    default:
      // Unknown or missing stop reason: never report it as a completed answer.
      throw new LLMProviderError("unknown");
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
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let client = opts.client;
  const getClient = (): AnthropicLike => {
    if (!client) {
      if (!opts.apiKey) throw new LLMProviderError("unauthorized");
      const sdk = new Anthropic({
        apiKey: opts.apiKey,
        maxRetries: opts.maxRetries ?? 2,
        timeout: defaultTimeout,
        // Pinned so ANTHROPIC_BASE_URL / ANTHROPIC_LOG / ANTHROPIC_OPEN_TELEMETRY_* cannot redirect traffic or log bodies.
        // ANTHROPIC_CUSTOM_HEADERS has no off switch: getAnthropicEnv (core) refuses it before a provider is built.
        baseURL: "https://api.anthropic.com",
        logLevel: "off",
        openTelemetry: false,
      });
      // Typed assignment, no cast: SDK drift in the slice we use fails typecheck.
      const messages: AnthropicLike["messages"] = sdk.messages;
      client = { messages };
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
        const params = buildParams(req, model);
        const c = getClient();
        const options: RequestOpts = { timeout: req.timeoutMs ?? defaultTimeout, ...(req.signal ? { signal: req.signal } : {}) };
        let message: Msg;
        let streamRequestId: string | null = null;
        if (req.stream || req.maxTokens > STREAM_ABOVE_MAX_TOKENS) {
          const s = c.messages.stream(params, options);
          message = await s.finalMessage();
          // finalMessage() is a snapshot without _request_id; the stream object carries it.
          streamRequestId = s.request_id ?? null;
        } else {
          message = await c.messages.create(params, options);
        }
        const result = mapMessage(message, Date.now() - started, streamRequestId);
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
