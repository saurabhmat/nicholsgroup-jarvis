import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { getLLMProvider } from "./config";
import {
  buildParams,
  createAnthropicProvider,
  LLMProviderError,
  MAX_TOKENS_CEILING,
  type AnthropicLike,
  type LLMCallLog,
  type LLMRequest,
} from "./index";
import { createMockProvider, textResult } from "./testing";

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

function fake(result: unknown, streamRequestId: string | null = "req_stream") {
  const seen: { kind: "create" | "stream"; params: Record<string, unknown>; options: unknown }[] = [];
  const respond = async () => {
    if (result instanceof Error) throw result;
    return result as never;
  };
  const client: AnthropicLike = {
    messages: {
      create: (params, options) => {
        seen.push({ kind: "create", params: params as never, options });
        return respond();
      },
      stream: (params, options) => {
        seen.push({ kind: "stream", params: params as never, options });
        // Like the SDK: the final message snapshot has no _request_id; the stream object carries it.
        return {
          finalMessage: async () => {
            const m = (await respond()) as Record<string, unknown>;
            const rest = { ...m };
            delete rest._request_id;
            return rest as never;
          },
          request_id: streamRequestId,
        };
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

  it("requires a valid laneId and a key when no client is injected", async () => {
    const p = createAnthropicProvider({ models, client: fake(msg()).client, logger: () => {} });
    for (const laneId of ["", "pkg", "PKG;DROP", "TOOLONGLANE"]) {
      await expect(p.complete({ ...base, laneId })).rejects.toMatchObject({ code: "invalid_request" });
    }
    const nokey = createAnthropicProvider({ models, logger: () => {} });
    await expect(nokey.complete(base)).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("T-100 review fixes", () => {
  const toolTurn = (ids: string[]): LLMRequest["messages"] => [
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t", signature: "sig-1" },
        ...ids.map((id) => ({ type: "tool_use" as const, id, name: "lookup", input: { a: 1 } })),
      ],
    },
  ];

  it("maps system blocks, tools and blocks with cache markers", () => {
    const p = buildParams(
      {
        ...base,
        system: [{ text: "stable", cache: "1h" }, { text: "per-run" }],
        tools: [{ name: "t", description: "d", inputSchema: {}, cache: "5m" }],
        messages: [{ role: "user", content: [{ type: "text", text: "x", cache: "5m" }] }],
      },
      "m",
    ) as unknown as Record<string, unknown>;
    expect(p.system).toEqual([
      { type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "per-run" },
    ]);
    expect((p.tools as Record<string, unknown>[])[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(p.messages)).toContain('"cache_control":{"type":"ephemeral"}');
    expect(buildParams(base, "m")).not.toHaveProperty("system");
  });

  it("round-trips [thinking, tool_use] -> [tool_result] with signature and order preserved", () => {
    const messages: LLMRequest["messages"] = [
      ...toolTurn(["tu_1", "tu_2"]),
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "tu_2", content: "r2" },
          { type: "tool_result", toolUseId: "tu_1", content: "r1", isError: true },
          { type: "text", text: "go on" },
        ],
      },
    ];
    const p = buildParams({ ...base, messages }, "m");
    const asst = p.messages[1]?.content as unknown as Record<string, unknown>[];
    expect(asst.map((b) => b.type)).toEqual(["thinking", "tool_use", "tool_use"]);
    expect(asst[0]).toMatchObject({ signature: "sig-1" });
    const user = p.messages[2]?.content as unknown as Record<string, unknown>[];
    expect(user.map((b) => b.tool_use_id ?? b.type)).toEqual(["tu_2", "tu_1", "text"]);
    expect(user[1]).toMatchObject({ is_error: true });
  });

  it("rejects malformed tool loops", () => {
    const bad: LLMRequest["messages"][] = [
      // missing a result
      [...toolTurn(["a", "b"]), { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "r" }] }],
      // text before the result
      [
        ...toolTurn(["a"]),
        { role: "user", content: [{ type: "text", text: "x" }, { type: "tool_result", toolUseId: "a", content: "r" }] },
      ],
      // id not from the previous assistant turn
      [...toolTurn(["a"]), { role: "user", content: [{ type: "tool_result", toolUseId: "zzz", content: "r" }] }],
      // duplicate
      [
        ...toolTurn(["a"]),
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "a", content: "r" },
            { type: "tool_result", toolUseId: "a", content: "r" },
          ],
        },
      ],
      // stray result with no tool_use before it
      [{ role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "r" }] }],
      // unanswered tool_use
      [...toolTurn(["a"]), { role: "user", content: "next" }],
    ];
    for (const messages of bad) expect(() => buildParams({ ...base, messages }, "m")).toThrow(LLMProviderError);
  });

  it("validates maxTokens and timeoutMs", () => {
    for (const maxTokens of [0, -1, 1.5, MAX_TOKENS_CEILING + 1, Number.NaN]) {
      expect(() => buildParams({ ...base, maxTokens }, "m")).toThrow(LLMProviderError);
    }
    for (const timeoutMs of [0, 1.5, 600_001]) expect(() => buildParams({ ...base, timeoutMs }, "m")).toThrow(LLMProviderError);
    expect(() => buildParams({ ...base, maxTokens: MAX_TOKENS_CEILING, timeoutMs: 5000 }, "m")).not.toThrow();
  });

  it("keeps the request id on streamed calls and passes the timeout", async () => {
    const { client, seen } = fake(msg());
    const p = createAnthropicProvider({ models, client, logger: () => {}, timeoutMs: 30_000 });
    expect(await p.complete({ ...base, stream: true })).toMatchObject({ requestId: "req_stream" });
    expect(seen[0]?.options).toMatchObject({ timeout: 30_000 });
    await p.complete({ ...base, timeoutMs: 5000 });
    expect(seen[1]?.options).toMatchObject({ timeout: 5000 });
  });

  it("fails closed on unknown stop reasons and unknown content blocks", async () => {
    for (const over of [{ stop_reason: "something_new" }, { stop_reason: null }, { content: [{ type: "server_tool_use", id: "x" }] }]) {
      const p = createAnthropicProvider({ models, logger: () => {}, client: fake(msg(over)).client });
      await expect(p.complete(base)).rejects.toMatchObject({ code: "unknown" });
    }
    const tool = createAnthropicProvider({ models, logger: () => {}, client: fake(msg({ stop_reason: "tool_use" })).client });
    expect(await tool.complete(base)).toMatchObject({ status: "tool_use" });
    const paused = createAnthropicProvider({ models, logger: () => {}, client: fake(msg({ stop_reason: "pause_turn" })).client });
    expect(await paused.complete(base)).toMatchObject({ status: "paused" });
  });

  it("pins the SDK endpoint and logging against env overrides (real client, wire level)", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetchSpy = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify(msg()), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_wire" },
      });
    }) as typeof fetch;
    const prior = { ...process.env };
    const printed: string[] = [];
    const spies = (["log", "info", "debug", "warn", "error"] as const).map((k) => {
      const orig = console[k];
      console[k] = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
      return () => (console[k] = orig);
    });
    process.env.ANTHROPIC_BASE_URL = "https://evil.example";
    process.env.ANTHROPIC_LOG = "debug";
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const p = createAnthropicProvider({ models, apiKey: "sk-ant-test", logger: () => {}, maxRetries: 0 });
      const r = await p.complete({ ...base, system: [{ text: "SECRET-SYSTEM", cache: "5m" }] });
      expect(r).toMatchObject({ status: "completed", requestId: "req_wire" });
      expect(sent[0]?.url.startsWith("https://api.anthropic.com/")).toBe(true);
      expect(sent[0]?.body).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 1000 });
      expect(printed.join("\n")).not.toContain("SECRET");
    } finally {
      process.env = prior;
      vi.unstubAllGlobals();
      spies.forEach((restore) => restore());
    }
  });
});

describe("getLLMProvider env refusals", () => {
  const good = {
    NODE_ENV: "test",
    ANTHROPIC_API_KEY: "sk-ant-api03-fake",
    ANTHROPIC_MODEL_ANALYSIS: "claude-sonnet-5-5",
    ANTHROPIC_MODEL_FAST: "claude-haiku-5-5",
  };
  for (const k of ["ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_BASE_URL", "ANTHROPIC_LOG", "ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE"]) {
    it(`refuses ${k}`, () => {
      expect(() => getLLMProvider({ env: { ...good, [k]: "x" } })).toThrow(/invalid: ANTHROPIC_/);
    });
  }
});

describe("mock provider", () => {
  it("returns scripted replies, records calls and throws scripted errors", async () => {
    const m = createMockProvider([textResult("a"), new LLMProviderError("rate_limited")]);
    expect(await m.complete(base)).toMatchObject({ content: [{ text: "a" }], model: "mock-analysis" });
    await expect(m.complete({ ...base, tier: "fast" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(m.calls).toHaveLength(2);
    expect(m.modelFor("fast")).toBe("mock-fast");
  });
  it("validates requests like the real provider and records clones", async () => {
    const m = createMockProvider([(req) => textResult(`echo ${req.tier}`)]);
    await expect(m.complete({ ...base, maxTokens: 0 })).rejects.toMatchObject({ code: "invalid_request" });
    const req = { ...base, messages: [{ role: "user" as const, content: "a" }] };
    expect(await m.complete(req)).toMatchObject({ content: [{ text: "echo analysis" }] });
    req.messages[0] = { role: "user", content: "mutated" };
    expect(m.calls[0]?.messages[0]?.content).toBe("a");
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
