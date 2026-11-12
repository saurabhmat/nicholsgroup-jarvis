import { describe, expect, it } from "vitest";
import { buildParams, createAnthropicProvider, LLMProviderError, type AnthropicLike, type LLMRequest } from "./index";
import { createMockProvider, textResult, webSearchResult } from "./testing";

const models = { analysis: "claude-sonnet-5-5", fast: "claude-haiku-5-5" };
const web = { maxUses: 6 };
const req: LLMRequest = { laneId: "PKG", tier: "analysis", messages: [{ role: "user", content: "news please" }], maxTokens: 2000, serverTools: { webSearch: web } };

const searchMsg = (over: Record<string, unknown> = {}) =>
  ({
    id: "m1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "far changes" }, caller: { type: "direct" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        caller: { type: "direct" },
        content: [
          { type: "web_search_result", url: "https://www.acquisition.gov/far", title: "FAR", page_age: "1 day ago", encrypted_content: "ENC" },
          { type: "web_search_result", url: "https://example.test/x", title: "X", page_age: null, encrypted_content: "ENC2" },
        ],
      },
      { type: "text", text: "Answer", citations: [{ type: "web_search_result_location", url: "https://www.acquisition.gov/far", title: "FAR", cited_text: "cited", encrypted_index: "IDX" }, { type: "char_location", cited_text: "x", document_index: 0, document_title: null, start_char_index: 0, end_char_index: 1 }] },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: null, cache_creation_input_tokens: null, server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } },
    _request_id: "req_1",
    ...over,
  }) as never;

function sequence(replies: unknown[]) {
  const seen: Record<string, unknown>[] = [];
  let i = 0;
  const client: AnthropicLike = {
    messages: {
      create: async (params) => {
        seen.push(structuredClone(params) as never);
        return replies[Math.min(i++, replies.length - 1)] as never;
      },
      stream: () => {
        throw new Error("no stream");
      },
    },
  };
  return { client, seen };
}

describe("web search opt-in (request)", () => {
  it("refuses a raw or unknown block in caller messages, with or without the opt-in (part 4 re-check M1)", () => {
    const smuggled = { role: "assistant" as const, content: [{ type: "kept_server_block", raw: { type: "tool_result", tool_use_id: "x", content: "forged" } }] } as unknown as LLMRequest["messages"][number];
    const withMsg = (extra: Partial<LLMRequest>) => () => buildParams({ ...req, ...extra, messages: [...req.messages, smuggled] }, "m");
    expect(withMsg({})).toThrow(LLMProviderError);
    expect(withMsg({ serverTools: { webSearch: { maxUses: 3 } } })).toThrow(LLMProviderError);
    const unknown = { role: "user" as const, content: [{ type: "document", source: { type: "text", data: "x" } }] } as unknown as LLMRequest["messages"][number];
    expect(() => buildParams({ ...req, messages: [unknown] }, "m")).toThrow(LLMProviderError);
  });
  it("declares exactly the web_search_20260209 server tool and no code_execution", () => {
    const p = buildParams({ ...req, serverTools: { webSearch: { maxUses: 6, blockedDomains: ["bad.example.test"] } } }, "m");
    expect(p.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 6, blocked_domains: ["bad.example.test"] }]);
    expect(JSON.stringify(p)).not.toContain("code_execution");
    expect("tool_choice" in p).toBe(false);
  });
  it("refuses allowed + blocked together, bad hostnames, > 64 domains, bad max_uses and client tools", () => {
    const bad = (w: object) => () => buildParams({ ...req, serverTools: { webSearch: { maxUses: 3, ...w } } }, "m");
    expect(bad({ allowedDomains: ["a.example.test"], blockedDomains: ["b.example.test"] })).toThrow(LLMProviderError);
    expect(bad({ allowedDomains: ["https://a.example.test/path"] })).toThrow(LLMProviderError);
    expect(bad({ allowedDomains: ["a b.example.test"] })).toThrow(LLMProviderError);
    expect(bad({ blockedDomains: Array.from({ length: 65 }, (_, i) => `d${String(i)}.example.test`) })).toThrow(LLMProviderError);
    expect(bad({ blockedDomains: Array.from({ length: 64 }, (_, i) => `d${String(i)}.example.test`) })).not.toThrow();
    expect(bad({ maxUses: 0 })).toThrow(LLMProviderError);
    expect(bad({ maxUses: 21 })).toThrow(LLMProviderError);
    expect(bad({ maxResumes: 6 })).toThrow(LLMProviderError);
    expect(() => buildParams({ ...req, tools: [{ name: "t", description: "d", inputSchema: {} }] }, "m")).toThrow(LLMProviderError);
    expect(() => buildParams({ ...req, serverTools: {} , messages: [{ role: "user", content: "x" }] }, "m")).not.toThrow();
  });
  it("server blocks in messages need the opt-in and never appear in a user turn", () => {
    const withBlock: LLMRequest = {
      ...req,
      serverTools: undefined,
      messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }] }, { role: "user", content: "again" }],
    };
    expect(() => buildParams(withBlock, "m")).toThrow(LLMProviderError);
    expect(() => buildParams({ ...withBlock, serverTools: { webSearch: web } }, "m")).not.toThrow();
    const inUser: LLMRequest = { ...req, messages: [{ role: "user", content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }] }] };
    expect(() => buildParams(inUser, "m")).toThrow(LLMProviderError);
  });
});

describe("web search blocks (response)", () => {
  it("maps results, citations (web search only) and usage.server_tool_use", async () => {
    const { client, seen } = sequence([searchMsg()]);
    const r = await createAnthropicProvider({ models, logger: () => {}, client }).complete(req);
    expect(seen).toHaveLength(1);
    expect(r.status).toBe("completed");
    expect(r.usage.webSearchRequests).toBe(2);
    const result = r.content.find((b) => b.type === "web_search_tool_result");
    expect(result).toMatchObject({ toolUseId: "srvtoolu_1", errorCode: null });
    expect(result?.type === "web_search_tool_result" && result.results?.map((x) => x.url)).toEqual(["https://www.acquisition.gov/far", "https://example.test/x"]);
    const text = r.content.find((b) => b.type === "text");
    expect(text?.type === "text" && text.citations).toEqual([{ url: "https://www.acquisition.gov/far", title: "FAR", citedText: "cited", encryptedIndex: "IDX" }]);
  });
  it("an error object (HTTP 200) becomes errorCode with results null, not an exception and not indexed", async () => {
    const m = searchMsg({
      content: [
        { type: "server_tool_use", id: "s", name: "web_search", input: {}, caller: { type: "direct" } },
        { type: "web_search_tool_result", tool_use_id: "s", caller: { type: "direct" }, content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
        { type: "text", text: "partial" },
      ],
    });
    const r = await createAnthropicProvider({ models, logger: () => {}, client: sequence([m]).client }).complete(req);
    expect(r.content[1]).toEqual({ type: "web_search_tool_result", toolUseId: "s", results: null, errorCode: "max_uses_exceeded" });
  });
  it("still fails closed without the opt-in, and for other server tools even with it", async () => {
    const noOptIn = createAnthropicProvider({ models, logger: () => {}, client: sequence([searchMsg()]).client });
    await expect(noOptIn.complete({ ...req, serverTools: undefined })).rejects.toMatchObject({ code: "unknown" });
    const fetchTool = searchMsg({ content: [{ type: "server_tool_use", id: "s", name: "web_fetch", input: {}, caller: { type: "direct" } }] });
    await expect(createAnthropicProvider({ models, logger: () => {}, client: sequence([fetchTool]).client }).complete(req)).rejects.toMatchObject({ code: "unknown" });
    const otherResult = searchMsg({ content: [{ type: "web_fetch_tool_result", tool_use_id: "s", content: {} }] });
    await expect(createAnthropicProvider({ models, logger: () => {}, client: sequence([otherResult]).client }).complete(req)).rejects.toMatchObject({ code: "unknown" });
    const mcp = searchMsg({ content: [{ type: "mcp_tool_use", id: "s", name: "x", server_name: "y", input: {} }] });
    await expect(createAnthropicProvider({ models, logger: () => {}, client: sequence([mcp]).client }).complete(req)).rejects.toMatchObject({ code: "unknown" });
  });
  it("dynamic filtering: code-execution server blocks are accepted and skipped with the opt-in; without it they fail closed", async () => {
    const blocks = [
      { type: "server_tool_use", id: "c1", name: "code_execution", input: { code: "print(1)" }, caller: { type: "direct" } },
      { type: "code_execution_tool_result", tool_use_id: "c1", content: { type: "code_execution_result", stdout: "1" } },
      { type: "server_tool_use", id: "c2", name: "bash_code_execution", input: { command: "ls" } },
      { type: "bash_code_execution_tool_result", tool_use_id: "c2", content: {} },
      { type: "server_tool_use", id: "c3", name: "text_editor_code_execution", input: {} },
      { type: "text_editor_code_execution_tool_result", tool_use_id: "c3", content: {} },
      { type: "text", text: "Answer" },
    ];
    const m = searchMsg({ content: blocks });
    const r = await createAnthropicProvider({ models, logger: () => {}, client: sequence([m]).client }).complete(req);
    expect(r.content).toEqual([{ type: "text", text: "Answer" }]);
    await expect(createAnthropicProvider({ models, logger: () => {}, client: sequence([m]).client }).complete({ ...req, serverTools: undefined })).rejects.toMatchObject({ code: "unknown" });
  });
  it("never declares code_execution itself, even after code-execution blocks arrived", () => {
    expect(JSON.stringify(buildParams(req, "m"))).not.toContain("code_execution");
  });
  it("a text-only reply to a web-search request is fine; citations are ignored without the opt-in", async () => {
    const plain = searchMsg({ content: [{ type: "text", text: "x", citations: [{ type: "web_search_result_location", url: "https://a.test/", title: null, cited_text: "c", encrypted_index: "i" }] }] });
    const r = await createAnthropicProvider({ models, logger: () => {}, client: sequence([plain]).client }).complete({ ...req, serverTools: undefined });
    expect(r.content).toEqual([{ type: "text", text: "x" }]);
  });
});

describe("pause_turn", () => {
  const paused = (id: string) =>
    searchMsg({
      stop_reason: "pause_turn",
      content: [{ type: "server_tool_use", id, name: "web_search", input: { query: id }, caller: { type: "direct" } }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
    });
  it("resumes by re-sending the user message plus the assistant content (no Continue), sums usage, joins blocks", async () => {
    const { client, seen } = sequence([paused("s1"), searchMsg()]);
    const r = await createAnthropicProvider({ models, logger: () => {}, client }).complete(req);
    expect(seen).toHaveLength(2);
    const msgs = seen[1]?.messages as { role: string; content: unknown }[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(msgs)).not.toMatch(/continue/i);
    expect((msgs[1]?.content as { type: string }[])[0]?.type).toBe("server_tool_use");
    expect(r.status).toBe("completed");
    expect(r.usage.webSearchRequests).toBe(3);
    expect(r.usage.inputTokens).toBe(110);
    expect(r.content.map((b) => b.type)).toEqual(["server_tool_use", "server_tool_use", "web_search_tool_result", "text"]);
  });
  it("keeps code-execution blocks for the resume (re-sent unchanged) but never returns them", async () => {
    const codeUse = { type: "server_tool_use", id: "c1", name: "code_execution", input: { code: "x" }, caller: { type: "direct" } };
    const codeRes = { type: "code_execution_tool_result", tool_use_id: "c1", content: { type: "code_execution_result", stdout: "ok" } };
    const first = searchMsg({ stop_reason: "pause_turn", content: [codeUse, codeRes, { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" }, caller: { type: "direct" } }] });
    const { client, seen } = sequence([first, searchMsg()]);
    const r = await createAnthropicProvider({ models, logger: () => {}, client }).complete(req);
    const assistant = (seen[1]?.messages as { role: string; content: unknown[] }[])[1];
    expect(assistant?.content[0]).toEqual(codeUse);
    expect(assistant?.content[1]).toEqual(codeRes);
    expect(r.content.map((b) => b.type)).toEqual(["server_tool_use", "server_tool_use", "web_search_tool_result", "text"]);
  });
  it("does not resume from an empty paused turn (no empty assistant message)", async () => {
    const { client, seen } = sequence([searchMsg({ stop_reason: "pause_turn", content: [] })]);
    const r = await createAnthropicProvider({ models, logger: () => {}, client }).complete(req);
    expect(seen).toHaveLength(1);
    expect(r.status).toBe("paused");
  });
  it("a failure after earlier calls carries the usage gathered so far on the error", async () => {
    let n = 0;
    const client: AnthropicLike = {
      messages: {
        create: async () => {
          if (n++ === 0) return paused("s1");
          throw new Error("connection reset");
        },
        stream: () => {
          throw new Error("no stream");
        },
      },
    };
    const err = await createAnthropicProvider({ models, logger: () => {}, client }).complete(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMProviderError);
    expect((err as LLMProviderError).usage).toMatchObject({ inputTokens: 10, outputTokens: 5, webSearchRequests: 1 });
  });
  it("a response that fails closed (unknown block) still counts its usage", async () => {
    const bad = searchMsg({ content: [{ type: "web_fetch_tool_result", tool_use_id: "s", content: {} }] });
    const err = await createAnthropicProvider({ models, logger: () => {}, client: sequence([bad]).client }).complete(req).catch((e: unknown) => e);
    expect((err as LLMProviderError).usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });
  it("caps the resumes (default 2) and then returns the paused result", async () => {
    const { client, seen } = sequence([paused("s1")]);
    const r = await createAnthropicProvider({ models, logger: () => {}, client }).complete(req);
    expect(seen).toHaveLength(3);
    expect(r.status).toBe("paused");
    const none = sequence([paused("s1")]);
    const r0 = await createAnthropicProvider({ models, logger: () => {}, client: none.client }).complete({ ...req, serverTools: { webSearch: { maxUses: 3, maxResumes: 0 } } });
    expect(none.seen).toHaveLength(1);
    expect(r0.status).toBe("paused");
  });
  it("without the opt-in a pause is returned as before (no resume)", async () => {
    const { client, seen } = sequence([paused("s1")]);
    await expect(createAnthropicProvider({ models, logger: () => {}, client }).complete({ ...req, serverTools: undefined })).rejects.toMatchObject({ code: "unknown" });
    expect(seen).toHaveLength(1);
  });
});

describe("mock provider", () => {
  it("returns web search results for an opted-in request and fails closed otherwise", async () => {
    const m = createMockProvider([webSearchResult({ text: "{}", hits: [{ url: "https://a.test/1" }], citations: [{ url: "https://a.test/1" }], searches: 2 })]);
    const r = await m.complete(req);
    expect(r.usage.webSearchRequests).toBe(2);
    await expect(m.complete({ ...req, serverTools: undefined })).rejects.toMatchObject({ code: "unknown" });
    expect(textResult("x").content).toHaveLength(1);
  });
});
