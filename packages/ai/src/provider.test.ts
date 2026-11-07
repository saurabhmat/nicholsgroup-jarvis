import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  buildParams,
  createAnthropicProvider,
  createMockProvider,
  getLLMProvider,
  LLMProviderError,
  textResult,
  type AnthropicLike,
  type LLMCallLog,
  type LLMRequest,
} from "./index";

const models = { analysis: "claude-sonnet-5-5", fast: "claude-haiku-5-5" };
const base: LLMRequest = {
  laneId: "PKG",
  tier: "analysis",
  messages: [{ role: "user", content: "SECRET-PROMPT-TEXT" }],
  maxTokens: 1000,
};

function msg(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "SECRET-COMPLETION-TEXT" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: 2 },
    _request_id: "req_1",
    ...over,
  } as never;
}

function fake(result: unknown) {
  const seen: { kind: "create" | "stream"; params: Record<string, unknown> }[] = [];
  const respond = async () => {
    if (result instanceof Error) throw result;
    return result as never;
  };
  const client: AnthropicLike = {
    messages: {
      create: (params) => {
        seen.push({ kind: "create", params: params as never });
        return respond();
      },
      stream: (params) => {
        seen.push({ kind: "stream", params: params as never });
        return { finalMessage: respond };
      },
    },
  };
  return { client, seen };
}

describe("buildParams", () => {
  it("sends only allowed fields", () => {
    const p = buildParams({ ...base, system: "sys", effort: "high", thinking: "adaptive" }, models.analysis) as unknown as Record<string, unknown>;
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ effort: "high" });
    for (const k of ["temperature", "top_p", "top_k"]) expect(p).not.toHaveProperty(k);
    expect(JSON.stringify(p)).not.toContain("budget_tokens");
  });
  it("omits thinking by default and never sends disabled", () => {
    expect(buildParams(base, "m")).not.toHaveProperty("thinking");
    const off = buildParams({ ...base, thinking: "off", effort: "high" }, "m");
    expect(off.thinking).toEqual({ type: "between_tools" });
    expect(JSON.stringify(off)).not.toContain("disabled");
  });
  it("rejects thinking off above effort high, and assistant prefill", () => {
    expect(() => buildParams({ ...base, thinking: "off", effort: "max" }, "m")).toThrow(LLMProviderError);
    expect(() => buildParams({ ...base, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "{" }] }, "m")).toThrow(
      LLMProviderError,
    );
  });
  it("uses tool_choice auto, never forced", () => {
    const p = buildParams({ ...base, tools: [{ name: "t", description: "d", inputSchema: { properties: {} } }] }, "m");
    expect(p.tool_choice).toEqual({ type: "auto" });
    expect(p.tools?.[0]).toMatchObject({ name: "t", input_schema: { type: "object" } });
  });
});

describe("anthropic provider", () => {
  it("uses configured model per tier and maps a completed result", async () => {
    const { client, seen } = fake(msg());
    const p = createAnthropicProvider({ models, client, logger: () => {} });
    const r = await p.complete({ ...base, tier: "fast" });
    expect(seen[0]?.params.model).toBe("claude-haiku-5-5");
    expect(r).toMatchObject({ status: "completed", stopReason: "end_turn", requestId: "req_1" });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 2 });
  });

  it("streams for large outputs", async () => {
    const { client, seen } = fake(msg());
    const p = createAnthropicProvider({ models, client, logger: () => {} });
    await p.complete({ ...base, maxTokens: 32_000 });
    await p.complete({ ...base, stream: true });
    await p.complete(base);
    expect(seen.map((s) => s.kind)).toEqual(["stream", "stream", "create"]);
  });

  it("returns refusal and max_tokens as typed results", async () => {
    const refused = createAnthropicProvider({
      models,
      logger: () => {},
      client: fake(msg({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } })).client,
    });
    expect(await refused.complete(base)).toMatchObject({ status: "refused", refusal: { category: "cyber" } });
    const cut = createAnthropicProvider({ models, logger: () => {}, client: fake(msg({ stop_reason: "max_tokens" })).client });
    expect(await cut.complete(base)).toMatchObject({ status: "max_tokens" });
  });

  it("maps typed SDK errors without copying their text", async () => {
    const cases: [Error, string, boolean][] = [
      [new Anthropic.RateLimitError(429, { error: "SECRET-PROMPT-TEXT" }, "SECRET-PROMPT-TEXT", new Headers()), "rate_limited", true],
      [new Anthropic.AuthenticationError(401, {}, "x", new Headers()), "unauthorized", false],
      [new Anthropic.BadRequestError(400, {}, "x", new Headers()), "invalid_request", false],
      [new Anthropic.InternalServerError(500, {}, "x", new Headers()), "server_error", true],
      [new Anthropic.APIConnectionTimeoutError(), "timeout", true],
      [new Error("whatever"), "unknown", false],
    ];
    for (const [err, code, retryable] of cases) {
      const p = createAnthropicProvider({ models, logger: () => {}, client: fake(err).client });
      const e = await p.complete(base).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LLMProviderError);
      expect(e).toMatchObject({ code, retryable });
      expect((e as Error).message).not.toContain("SECRET");
    }
  });

  it("logs metadata only, never prompt or completion text or the key", async () => {
    const logs: LLMCallLog[] = [];
    const p = createAnthropicProvider({ models, client: fake(msg()).client, logger: (e) => logs.push(e), apiKey: "sk-ant-test-KEY" });
    await p.complete({ ...base, system: "SECRET-SYSTEM" });
    await createAnthropicProvider({ models, logger: (e) => logs.push(e), client: fake(new Anthropic.RateLimitError(429, {}, "x", new Headers())).client })
      .complete(base)
      .catch(() => undefined);
    expect(logs).toHaveLength(2);
    expect(Object.keys(logs[0] ?? {}).sort()).toEqual(
      ["errorCode", "laneId", "latencyMs", "model", "outcome", "requestId", "stopReason", "tier", "usage"],
    );
    expect(logs[0]).toMatchObject({ laneId: "PKG", stopReason: "end_turn", requestId: "req_1", outcome: "ok" });
    expect(logs[1]).toMatchObject({ outcome: "error", errorCode: "rate_limited" });
    const all = JSON.stringify(logs);
    for (const s of ["SECRET", "sk-ant"]) expect(all).not.toContain(s);
  });

  it("requires a laneId and a key when no client is injected", async () => {
    const p = createAnthropicProvider({ models, client: fake(msg()).client, logger: () => {} });
    await expect(p.complete({ ...base, laneId: "" })).rejects.toMatchObject({ code: "invalid_request" });
    const nokey = createAnthropicProvider({ models, logger: () => {} });
    await expect(nokey.complete(base)).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("mock provider", () => {
  it("returns scripted replies, records calls and throws scripted errors", async () => {
    const m = createMockProvider([textResult("a"), new LLMProviderError("rate_limited")]);
    expect(await m.complete(base)).toMatchObject({ content: [{ text: "a" }], model: "mock-analysis" });
    await expect(m.complete({ ...base, tier: "fast" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(m.calls).toHaveLength(2);
    expect(m.modelFor("fast")).toBe("mock-fast");
  });
});

describe("getLLMProvider", () => {
  it("is not configured when the group is absent", () => {
    const r = getLLMProvider({ env: { NODE_ENV: "test" } });
    expect(r.configured).toBe(false);
    if (!r.configured) expect(r.missing).toContain("ANTHROPIC_API_KEY");
  });
  it("builds a provider from env without exposing the key", () => {
    const r = getLLMProvider({
      env: {
        NODE_ENV: "test",
        ANTHROPIC_API_KEY: "sk-ant-api03-fake",
        ANTHROPIC_MODEL_ANALYSIS: "claude-sonnet-5-5",
        ANTHROPIC_MODEL_FAST: "claude-haiku-5-5",
      },
    });
    expect(r.configured).toBe(true);
    if (r.configured) {
      expect(r.provider.modelFor("analysis")).toBe("claude-sonnet-5-5");
      expect(r.provider.modelFor("fast")).toBe("claude-haiku-5-5");
      expect(JSON.stringify(r.provider)).not.toContain("sk-ant");
    }
  });
});
