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
  LLMWebSearch,
  CacheTtl,
  LLMCitation,
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

/**
 * A server-side code-execution block (web_search_20260209 may use code execution for dynamic result filtering). It is never
 * mapped to the app, but it is kept for the pause_turn resume and re-sent UNCHANGED. Internal to this file.
 */
type KeptBlock = { type: "kept_server_block"; raw: unknown };
type InternalBlock = LLMContentBlock | KeptBlock;
const CODE_EXEC_TOOLS = new Set(["code_execution", "bash_code_execution", "text_editor_code_execution"]);
const CODE_EXEC_RESULTS = new Set(["code_execution_tool_result", "bash_code_execution_tool_result", "text_editor_code_execution_tool_result"]);
const PUBLIC_BLOCK_TYPES: ReadonlySet<string> = new Set(["text", "tool_use", "tool_result", "thinking", "redacted_thinking", "server_tool_use", "web_search_tool_result"]);
const publicBlocks = (blocks: InternalBlock[]): LLMContentBlock[] => blocks.filter((b): b is LLMContentBlock => b.type !== "kept_server_block");

function toBlock(b: InternalBlock): Anthropic.ContentBlockParam {
  switch (b.type) {
    case "kept_server_block":
      return b.raw as Anthropic.ContentBlockParam;
    case "text":
      return {
        type: "text",
        text: b.text,
        ...cacheControl(b.cache),
        ...(b.citations?.length
          ? { citations: b.citations.map((c) => ({ type: "web_search_result_location" as const, url: c.url, title: c.title, cited_text: c.citedText, encrypted_index: c.encryptedIndex })) }
          : {}),
      };
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
    case "server_tool_use":
      return { type: "server_tool_use", id: b.id, name: b.name, input: b.input };
    case "web_search_tool_result":
      return {
        type: "web_search_tool_result",
        tool_use_id: b.toolUseId,
        content:
          b.results === null
            ? { type: "web_search_tool_result_error", error_code: (b.errorCode ?? "unavailable") as Anthropic.WebSearchToolRequestError["error_code"] }
            : b.results.map((r) => ({ type: "web_search_result" as const, url: r.url, title: r.title, page_age: r.pageAge, encrypted_content: r.encryptedContent })),
      };
  }
}

function toMessage(m: { role: "user" | "assistant"; content: string | InternalBlock[] }): Anthropic.MessageParam {
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

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_DOMAINS = 64;
const MAX_SEARCH_USES = 20;
const MAX_RESUMES = 5;
export const DEFAULT_MAX_RESUMES = 2;
const isServerBlock = (b: LLMContentBlock) => b.type === "server_tool_use" || b.type === "web_search_tool_result" || (b.type === "text" && !!b.citations?.length);

/** The web search opt-in must be well formed: bounded uses, plain hostnames, never both domain lists. */
function validateWebSearch(w: LLMWebSearch): void {
  if (!Number.isInteger(w.maxUses) || w.maxUses < 1 || w.maxUses > MAX_SEARCH_USES) throw new LLMProviderError("invalid_request");
  if (w.maxResumes !== undefined && (!Number.isInteger(w.maxResumes) || w.maxResumes < 0 || w.maxResumes > MAX_RESUMES)) throw new LLMProviderError("invalid_request");
  if (w.allowedDomains && w.blockedDomains) throw new LLMProviderError("invalid_request");
  for (const list of [w.allowedDomains, w.blockedDomains]) {
    if (!list) continue;
    if (list.length === 0 || list.length > MAX_DOMAINS || list.some((d) => typeof d !== "string" || !HOSTNAME.test(d))) throw new LLMProviderError("invalid_request");
  }
}

/**
 * Pure request builder (exported for tests). Throws invalid_request for combinations the API rejects.
 * `resume` (internal, set only by the provider's pause_turn loop) appends the assistant content of the paused turn after the
 * user messages; a caller's own messages must still end with a user message.
 */
export function buildParams(req: LLMRequest, model: string, resume?: InternalBlock[]): Params {
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
  const web = req.serverTools?.webSearch;
  if (web) {
    validateWebSearch(web);
    if (req.tools?.length) throw new LLMProviderError("invalid_request"); // server tools are isolated from Jarvis tools (plan-review 11)
  } else if (req.serverTools !== undefined && Object.keys(req.serverTools).length > 0) {
    throw new LLMProviderError("invalid_request");
  }
  // Caller messages may contain only the public block kinds. The internal kept_server_block (raw provider JSON, re-sent
  // unchanged) is valid ONLY in `resume`, which this file builds itself; a caller that builds messages from stored or
  // deserialised JSON can never smuggle raw blocks past the tool round-trip and server-block checks (part 4 re-check M1).
  if (req.messages.some((m) => blocksOf(m).some((b) => !PUBLIC_BLOCK_TYPES.has((b as { type?: unknown }).type as string)))) throw new LLMProviderError("invalid_request");
  // Server-side blocks (and citations) in the messages are only valid for a request that opted in.
  if (!web && (req.messages.some((m) => blocksOf(m).some(isServerBlock)) || resume)) throw new LLMProviderError("invalid_request");
  if (req.messages.some((m) => m.role === "user" && blocksOf(m).some(isServerBlock))) throw new LLMProviderError("invalid_request");
  const params: Params = {
    model,
    max_tokens: req.maxTokens,
    messages: [...req.messages.map(toMessage), ...(resume ? [toMessage({ role: "assistant", content: resume })] : [])],
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
  if (web) {
    // Current-model variant. code_execution is deliberately NOT declared. Never both domain lists (validated above).
    params.tools = [
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: web.maxUses,
        ...(web.allowedDomains ? { allowed_domains: web.allowedDomains } : {}),
        ...(web.blockedDomains ? { blocked_domains: web.blockedDomains } : {}),
      },
    ];
  }
  return params;
}

function mapUsage(u: Msg["usage"]): LLMUsage {
  const searches = u.server_tool_use?.web_search_requests;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    ...(typeof searches === "number" ? { webSearchRequests: searches } : {}),
  };
}

function sumUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  const searches = (a.webSearchRequests ?? 0) + (b.webSearchRequests ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    ...(a.webSearchRequests !== undefined || b.webSearchRequests !== undefined ? { webSearchRequests: searches } : {}),
  };
}

function mapCitations(cs: Anthropic.TextCitation[] | null | undefined): LLMCitation[] {
  const out: LLMCitation[] = [];
  for (const c of cs ?? []) {
    // Only web search citations are meaningful here; any other kind (documents) never occurs without documents and is dropped.
    if (c.type === "web_search_result_location") out.push({ url: c.url, title: c.title, citedText: c.cited_text, encryptedIndex: c.encrypted_index });
  }
  return out;
}

function mapContent(blocks: Msg["content"], webSearch: boolean): InternalBlock[] {
  const out: InternalBlock[] = [];
  for (const b of blocks) {
    const kind = (b as { type: string }).type;
    const toolName = (b as { name?: unknown }).name;
    if (webSearch && ((kind === "server_tool_use" && typeof toolName === "string" && CODE_EXEC_TOOLS.has(toolName)) || CODE_EXEC_RESULTS.has(kind))) {
      // Dynamic filtering by the web search tool: accepted, not mapped, kept for the resume. Never declared by us.
      out.push({ type: "kept_server_block", raw: b });
      continue;
    }
    if (b.type === "text") {
      const citations = webSearch ? mapCitations(b.citations) : [];
      out.push({ type: "text", text: b.text, ...(citations.length ? { citations } : {}) });
    } else if (webSearch && b.type === "server_tool_use" && b.name === "web_search") {
      out.push({ type: "server_tool_use", id: b.id, name: "web_search", input: b.input });
    } else if (webSearch && b.type === "web_search_tool_result") {
      // Success is a LIST of results; failure is an ERROR OBJECT (HTTP 200). Branch before indexing.
      const c: unknown = b.content;
      if (Array.isArray(c)) {
        out.push({
          type: "web_search_tool_result",
          toolUseId: b.tool_use_id,
          results: c.flatMap((r: Anthropic.WebSearchResultBlock) =>
            r && r.type === "web_search_result" && typeof r.url === "string" ? [{ url: r.url, title: typeof r.title === "string" ? r.title : "", pageAge: typeof r.page_age === "string" ? r.page_age : null, encryptedContent: r.encrypted_content }] : [],
          ),
          errorCode: null,
        });
      } else {
        const code = (c as { error_code?: unknown } | null)?.error_code;
        out.push({ type: "web_search_tool_result", toolUseId: b.tool_use_id, results: null, errorCode: typeof code === "string" ? code : "unavailable" });
      }
    }
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    else if (b.type === "thinking") out.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
    else if (b.type === "redacted_thinking") out.push({ type: "redacted_thinking", data: b.data });
    // Server-side block kinds are never requested (no server tools), so one arriving means drift: fail closed.
    else throw new LLMProviderError("unknown");
  }
  return out;
}

export function mapMessage(m: Msg, latencyMs: number, requestId?: string | null, opts: { webSearch?: boolean } = {}): LLMResult {
  return stripKept(mapMessageKeep(m, latencyMs, requestId, opts));
}

const stripKept = (r: InternalResult): LLMResult => ({ ...r, content: publicBlocks(r.content) }) as unknown as LLMResult;
type WithInternalContent<T> = T extends unknown ? Omit<T, "content"> & { content: InternalBlock[] } : never;
type InternalResult = WithInternalContent<LLMResult>;

function mapMessageKeep(m: Msg, latencyMs: number, requestId?: string | null, opts: { webSearch?: boolean } = {}): InternalResult {
  const common = {
    content: mapContent(m.content, opts.webSearch === true),
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
      let usageSoFar: LLMUsage | undefined;
      try {
        const web = req.serverTools?.webSearch;
        const c = getClient();
        const options: RequestOpts = { timeout: req.timeoutMs ?? defaultTimeout, ...(req.signal ? { signal: req.signal } : {}) };
        const once = async (resume?: InternalBlock[]) => {
          const params = buildParams(req, model, resume);
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
          // Counted as soon as a response arrived, before any mapping can fail closed: it was billed either way.
          usageSoFar = usageSoFar ? sumUsage(usageSoFar, mapUsage(message.usage)) : mapUsage(message.usage);
          return mapMessageKeep(message, Date.now() - started, streamRequestId, { webSearch: web !== undefined });
        };
        let internal = await once();
        // pause_turn (web search only): resume by re-sending the user messages plus the assistant content so far (no "Continue"
        // message), at most maxResumes times. The final result carries every block and the summed usage. Code-execution blocks
        // from dynamic filtering are carried for the resume and removed from what the caller sees.
        if (web) {
          const cap = web.maxResumes ?? DEFAULT_MAX_RESUMES;
          let all = internal.content;
          let usage = internal.usage;
          for (let n = 0; internal.status === "paused" && n < cap; n++) {
            if (all.length === 0) break; // nothing to resume from: an empty assistant message would be rejected
            internal = await once(all);
            all = [...all, ...internal.content];
            usage = sumUsage(usage, internal.usage);
          }
          internal = { ...internal, content: all, usage };
        }
        const result = stripKept(internal);
        log({ stopReason: result.stopReason, usage: result.usage, requestId: result.requestId, model: result.model });
        return result;
      } catch (err) {
        const e = mapError(err);
        if (usageSoFar && !e.usage) e.usage = usageSoFar;
        log({ outcome: "error", errorCode: e.code, requestId: e.requestId });
        throw e;
      }
    },
  };
}
