import type { Audit } from "@nichols/core/audit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMockProvider } from "../testing";
import type { LLMContentBlock, LLMResult } from "../types";
import { createPolicyGate } from "./gate";
import { FINAL_STEP_NOTE, runToolLoop, type ToolLoopInput } from "./loop";
import { createToolRegistry } from "./registry";

const USER = "00000000-0000-4000-8000-000000000001";
const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const res = (status: LLMResult["status"], content: LLMContentBlock[]): LLMResult =>
  ({
    status,
    stopReason: { completed: "end_turn", tool_use: "tool_use", max_tokens: "max_tokens", paused: "pause_turn", refused: "refusal" }[status],
    ...(status === "refused" ? { refusal: { category: null } } : {}),
    content,
    usage,
    model: "m",
    requestId: null,
    latencyMs: 0,
  }) as LLMResult;
const mrr = (id: string): LLMContentBlock => ({ type: "tool_use", id, name: "get_mrr", input: { month: "2026-11" } });

function setup(opts: { failRun?: boolean } = {}) {
  const reg = createToolRegistry();
  let runs = 0;
  const signals: (AbortSignal | undefined)[] = [];
  reg.register({
    name: "get_mrr",
    description: "MRR",
    category: "finance",
    effect: "read",
    requiredView: "finance",
    args: z.strictObject({ month: z.string() }),
    resultStore: "full",
    trustedFields: ["display"],
    run: async (ctx) => {
      runs++;
      signals.push(ctx.signal);
      if (opts.failRun) throw new Error("db down");
      return { data: { display: "$1.00" }, sources: [], asOf: "2026-11-08T00:00:00Z", freshness: "cached", notes: [] };
    },
  });
  const audit: Audit = { log: async () => undefined };
  const client = { schema: () => ({ rpc: async () => ({ data: { allowed: true, reason: null, role: "owner" }, error: null }) }) };
  const gate = createPolicyGate({
    registry: reg,
    audit,
    requireSession: async () => ({ userId: USER }),
    requireLane: async () => ({ session: { userId: USER }, client: client as never }),
  });
  const base = (replies: Parameters<typeof createMockProvider>[0], over: Partial<ToolLoopInput> = {}) => {
    const provider = createMockProvider(replies);
    const input: ToolLoopInput = {
      provider,
      gate,
      registry: reg,
      laneId: "PKG",
      tier: "fast",
      system: "s",
      messages: [{ role: "user", content: "q" }],
      categories: ["finance"],
      maxTokens: 100,
      ...over,
    };
    return { provider, input };
  };
  return { base, runs: () => runs, signals };
}

describe("runToolLoop", () => {
  it("handles several tool_use blocks in one turn and reports hooks in order", async () => {
    const s = setup();
    const events: string[] = [];
    const { input } = s.base([res("tool_use", [{ type: "text", text: "Let me check. " }, mrr("a"), mrr("b")]), res("completed", [{ type: "text", text: "Done." }])], {
      hooks: {
        onText: (t) => events.push(`text:${t}`),
        onToolStart: (c) => events.push(`start:${c.toolUseId}`),
        onToolResult: (c) => events.push(`result:${c.toolUseId}:${c.outcome}`),
      },
    });
    const out = await runToolLoop(input);
    expect(out).toMatchObject({ stop: "completed", text: "Let me check. Done.", steps: 2 });
    expect(events).toEqual(["text:Let me check. ", "start:a", "result:a:ok", "start:b", "result:b:ok", "text:Done."]);
    expect(s.runs()).toBe(2);
  });

  it("passes the abort signal to tools and stops between steps", async () => {
    const s = setup();
    const ctl = new AbortController();
    const { input } = s.base([res("tool_use", [mrr("a")]), res("completed", [])], {
      signal: ctl.signal,
      hooks: { onToolResult: () => ctl.abort() },
    });
    await expect(runToolLoop(input)).rejects.toMatchObject({ code: "aborted" });
    expect(s.signals[0]).toBe(ctl.signal);
  });

  it("returns refused and max_tokens as stops, dropping unanswered tool_use blocks", async () => {
    const s = setup();
    const refused = await runToolLoop(s.base([res("refused", [])]).input);
    expect(refused.stop).toBe("refused");
    const cut = await runToolLoop(s.base([res("max_tokens", [{ type: "text", text: "partial" }, mrr("x")])]).input);
    expect(cut.stop).toBe("max_tokens");
    expect(JSON.stringify(cut.messages.at(-1))).not.toContain("tool_use");
    expect(s.runs()).toBe(0);
  });

  it("treats pause_turn as a terminal stop with the partial text (server tools are never used)", async () => {
    const s = setup();
    const out = await runToolLoop(s.base([res("paused", [{ type: "text", text: "a" }])]).input);
    expect(out).toMatchObject({ stop: "paused", text: "a", steps: 1 });
  });

  it("asks for the answer before the budget runs out, and never leaves an unanswered tool_use", async () => {
    const s = setup();
    let i = 0;
    const { provider, input } = s.base([() => res("tool_use", [mrr(`t${i++}`)])], { maxSteps: 3 });
    const out = await runToolLoop(input);
    expect(out).toMatchObject({ stop: "max_steps", steps: 3 });
    expect(out.toolCalls).toHaveLength(2);
    expect(JSON.stringify(provider.calls[2]?.messages.at(-1))).toContain(FINAL_STEP_NOTE);
    expect(out.messages.at(-1)?.role).toBe("user");
  });

  it("reports a failing tool as tool_failed with fixed text", async () => {
    const s = setup({ failRun: true });
    const { provider, input } = s.base([res("tool_use", [mrr("a")]), res("completed", [])]);
    const out = await runToolLoop(input);
    expect(out.toolCalls[0]?.outcome).toBe("tool_failed");
    expect(JSON.stringify(provider.calls[1]?.messages)).not.toContain("db down");
  });

  it("validates maxSteps and sanitises model-chosen tool names", async () => {
    const s = setup();
    await expect(runToolLoop(s.base([], { maxSteps: 0 }).input)).rejects.toThrow(/maxSteps/);
    const out = await runToolLoop(s.base([res("tool_use", [{ type: "tool_use", id: "z", name: "Bad Name<script>", input: {} }]), res("completed", [])]).input);
    expect(out.toolCalls[0]).toMatchObject({ name: "invalid", outcome: "unknown_tool" });
  });
});
