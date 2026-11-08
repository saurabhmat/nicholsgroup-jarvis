// Tool loop (T-102; the chat route T-105 builds on it). One assistant turn: model → tool_use → policy gate → wrapped
// tool_result → model, until the model stops or maxSteps. Server-side guarantees, whatever the model does:
// - laneId is the server's (the conversation's); anything the model puts in arguments is rejected by strict schemas.
// - propose tools run only when the user started this turn with an explicit action (userInitiatedPropose), never
//   because retrieved content asked for it.
// - tool results reach the model as JSON with external text wrapped as untrusted data (../untrusted.ts).
// - the system prompt always carries UNTRUSTED_DATA_RULE and never contains wrapped (retrieved) content.
import type { LaneId } from "@nichols/core";
import type { LLMContentBlock, LLMMessage, LLMProvider, LLMResult, LLMSystemBlock, ModelTier } from "../types";
import { containsUntrustedTag, UNTRUSTED_DATA_RULE, wrapFields, wrapUntrusted } from "../untrusted";
import { DENY_MESSAGES, type DenyReason, type PolicyGate } from "./gate";
import type { ToolCategory, ToolDescriptor, ToolRegistry, ToolResult } from "./registry";

export type LoopDenyReason = DenyReason | "propose_not_allowed";

export type ToolLoopInput = {
  provider: LLMProvider;
  gate: PolicyGate;
  registry: ToolRegistry;
  laneId: LaneId;
  tier: ModelTier;
  system: string | LLMSystemBlock[];
  messages: LLMMessage[];
  /** The lane's llm_allowed_categories: only these tools are offered (the gate checks again). */
  categories: readonly ToolCategory[];
  maxTokens: number;
  /** Model calls per turn. Default 6. */
  maxSteps?: number;
  /** True only when the user pressed an explicit action that may create a proposal. Default false. */
  userInitiatedPropose?: boolean;
  signal?: AbortSignal;
};

export type ToolCallRecord = { name: string; toolUseId: string; outcome: "ok" | LoopDenyReason };

export type ToolLoopResult = {
  stop: "completed" | "max_steps" | "refused" | "max_tokens" | "paused";
  text: string;
  steps: number;
  toolCalls: ToolCallRecord[];
  /** Successful tool results, for grounding and citations (T-103/T-105). */
  results: { tool: ToolDescriptor; toolUseId: string; result: ToolResult<unknown> }[];
  /** Full message list including this turn (thinking blocks are transient: never store them). */
  messages: LLMMessage[];
};

const WRAP_EVERYTHING: ReadonlySet<ToolCategory> = new Set(["email", "docs"]);

/** The tool_result text for the model: the result as JSON, external strings wrapped. */
export function toolResultContent(tool: ToolDescriptor, result: ToolResult<unknown>): string {
  // Mail and documents are external text throughout: without declared fields, every string is wrapped.
  const paths = tool.untrustedFields?.length ? tool.untrustedFields : WRAP_EVERYTHING.has(tool.category) ? ["*"] : [];
  const data = paths.includes("*") ? wrapFields({ v: result.data }, ["v"], tool.name).v : wrapFields(result.data, paths, tool.name);
  return JSON.stringify({
    data,
    // Source labels can be external names (customers, senders): always wrapped.
    sources: result.sources.map((s) => ({ ...s, ...(s.label !== undefined ? { label: wrapUntrusted(s.label, { source: tool.name, id: s.id }) } : {}) })),
    asOf: result.asOf,
    freshness: result.freshness,
    notes: result.notes,
  });
}

function withRule(system: string | LLMSystemBlock[]): LLMSystemBlock[] {
  const blocks = typeof system === "string" ? (system ? [{ text: system }] : []) : system;
  if (blocks.some((b) => containsUntrustedTag(b.text.replaceAll(UNTRUSTED_DATA_RULE, "")))) {
    // Retrieved content never goes in the system prompt (T-100 security review L3).
    throw new Error("system prompt contains untrusted data");
  }
  return blocks.some((b) => b.text.includes(UNTRUSTED_DATA_RULE)) ? blocks : [...blocks, { text: UNTRUSTED_DATA_RULE }];
}

const textOf = (r: LLMResult) =>
  r.content
    .filter((b): b is Extract<LLMContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const system = withRule(input.system);
  const tools = input.registry.llmTools(input.categories);
  const maxSteps = input.maxSteps ?? 6;
  const messages: LLMMessage[] = [...input.messages];
  const toolCalls: ToolCallRecord[] = [];
  const results: ToolLoopResult["results"] = [];

  for (let step = 1; step <= maxSteps; step++) {
    const r = await input.provider.complete({
      laneId: input.laneId,
      tier: input.tier,
      system,
      messages,
      maxTokens: input.maxTokens,
      ...(tools.length ? { tools } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    messages.push({ role: "assistant", content: r.content });
    if (r.status !== "tool_use") {
      const stop = r.status === "refused" ? "refused" : r.status === "max_tokens" ? "max_tokens" : r.status === "paused" ? "paused" : "completed";
      return { stop, text: textOf(r), steps: step, toolCalls, results, messages };
    }
    if (step === maxSteps) {
      // Do not leave an unanswered tool_use in the history.
      messages.pop();
      return { stop: "max_steps", text: textOf(r), steps: step, toolCalls, results, messages };
    }

    const answers: LLMContentBlock[] = [];
    for (const b of r.content) {
      if (b.type !== "tool_use") continue;
      const tool = input.registry.get(b.name);
      if (tool?.effect === "propose" && !input.userInitiatedPropose) {
        toolCalls.push({ name: b.name, toolUseId: b.id, outcome: "propose_not_allowed" });
        answers.push({
          type: "tool_result",
          toolUseId: b.id,
          content: JSON.stringify({ error: "Proposals can only be made when the user asks for one directly." }),
          isError: true,
        });
        continue;
      }
      // The server's laneId; the model's arguments go to the strict schema as they are.
      const out = await input.gate.call({ laneId: input.laneId, toolName: b.name, toolUseId: b.id, args: b.input });
      if (out.ok) {
        toolCalls.push({ name: b.name, toolUseId: b.id, outcome: "ok" });
        results.push({ tool: out.tool, toolUseId: b.id, result: out.result });
        answers.push({ type: "tool_result", toolUseId: b.id, content: toolResultContent(out.tool, out.result) });
      } else {
        toolCalls.push({ name: b.name, toolUseId: b.id, outcome: out.reason });
        answers.push({ type: "tool_result", toolUseId: b.id, content: JSON.stringify({ error: out.message ?? DENY_MESSAGES[out.reason] }), isError: true });
      }
    }
    messages.push({ role: "user", content: answers });
  }
  /* c8 ignore next */
  throw new Error("unreachable");
}
