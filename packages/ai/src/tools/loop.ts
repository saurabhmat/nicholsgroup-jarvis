// Tool loop (T-102; the chat route T-105 builds on it). One assistant turn: model → tool_use → policy gate → wrapped
// tool_result → model, until the model stops or maxSteps. Server-side guarantees, whatever the model does:
// - laneId is the server's (the conversation's); anything the model puts in arguments is rejected by strict schemas.
// - a propose tool runs only as the one proposal the user's explicit action allows (`proposal`: that tool, once,
//   with server-checked arguments), never
//   because retrieved content asked for it.
// - tool results reach the model as JSON with external text wrapped as untrusted data (../untrusted.ts).
// - the system prompt always carries UNTRUSTED_DATA_RULE and never contains wrapped (retrieved) content.
import type { LaneId } from "@nichols/core";
import { LLMProviderError } from "../types";
import type { LLMContentBlock, LLMMessage, LLMProvider, LLMResult, LLMSystemBlock, ModelTier } from "../types";
import { containsUntrustedTag, UNTRUSTED_DATA_RULE, wrapExcept, wrapUntrusted } from "../untrusted";
import { DENY_MESSAGES, type AllowedProposal, type DenyReason, type PolicyGate } from "./gate";
import type { ToolCategory, ToolDescriptor, ToolRegistry, ToolResult } from "./registry";

export type LoopDenyReason = DenyReason;

/** Event hooks for streaming (T-105 maps them to SSE). They observe; they cannot change what runs. */
export type ToolLoopHooks = {
  onText?(text: string, step: number): void;
  onToolStart?(call: { name: string; toolUseId: string }): void;
  onToolResult?(call: ToolCallRecord, result: ToolResult<unknown> | null): void;
};

const MAX_STEPS = 10;
const MAX_TOOL_USES_PER_STEP = 8;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export const FINAL_STEP_NOTE = "Tool budget reached for this turn: answer now with what you have, without calling more tools.";

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
  /**
   * Set only when the user pressed an explicit action that may create a proposal ("Draft reply" on a message): that
   * one tool, at most once this turn, with arguments the server-side check accepts. Never set from model output.
   */
  proposal?: AllowedProposal;
  /** Abort (client disconnected): stops between steps and is passed to the provider and to tools. */
  signal?: AbortSignal;
  hooks?: ToolLoopHooks;
};

export type ToolCallRecord = { name: string; toolUseId: string; outcome: "ok" | LoopDenyReason; auditIncomplete: boolean };

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


const SOURCE_ID = /^[A-Za-z0-9_.:/@-]{1,120}$/;

/**
 * The tool_result text for the model: the result as JSON, every string wrapped as untrusted data except the tool's
 * trustedFields (fail closed). Sources go to the model as {kind, id, label}: ids that are not plain become their
 * index, labels are wrapped, urls stay server-side (citations only; a signed url could carry a token). Notes are
 * wrapped. Throws UntrustedDataError for non-JSON data.
 */
export function toolResultContent(tool: ToolDescriptor, result: ToolResult<unknown>): string {
  return JSON.stringify({
    data: wrapExcept(result.data, tool.trustedFields, tool.name),
    sources: result.sources.map((s, i) => ({
      kind: SOURCE_ID.test(s.kind) ? s.kind : "source",
      id: SOURCE_ID.test(s.id) ? s.id : `source_${i}`,
      ...(s.label !== undefined ? { label: wrapUntrusted(s.label, { source: tool.name, id: `sources.${i}.label` }) } : {}),
    })),
    asOf: result.asOf,
    freshness: result.freshness,
    notes: result.notes.map((n, i) => wrapUntrusted(n, { source: tool.name, id: `notes.${i}` })),
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
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS) throw new Error("maxSteps must be 1..10");
  let proposalUsed = false;
  const hooks = input.hooks ?? {};
  const messages: LLMMessage[] = [...input.messages];
  const toolCalls: ToolCallRecord[] = [];
  const results: ToolLoopResult["results"] = [];
  let text = "";

  for (let step = 1; ; step++) {
    if (input.signal?.aborted) throw new LLMProviderError("aborted");
    const r = await input.provider.complete({
      laneId: input.laneId,
      tier: input.tier,
      system,
      messages,
      maxTokens: input.maxTokens,
      ...(tools.length ? { tools } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const toolUses = r.content.filter((b): b is Extract<LLMContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    // Only a tool_use turn may carry tool_use blocks into history (they must be answered next).
    const kept = r.status === "tool_use" ? r.content : r.content.filter((b) => b.type !== "tool_use");
    messages.push({ role: "assistant", content: kept });
    const stepText = textOf(r);
    if (stepText) {
      text += stepText;
      hooks.onText?.(stepText, step);
    }
    // pause_turn only occurs with server-side tools, which are never sent; resuming would need an assistant-last
    // request (prefill), which the provider refuses. So "paused" is a terminal stop: the caller shows the partial text.
    if (r.status !== "tool_use" || toolUses.length === 0) {
      const stop = r.status === "refused" ? "refused" : r.status === "max_tokens" ? "max_tokens" : r.status === "paused" ? "paused" : "completed";
      return { stop, text, steps: step, toolCalls, results, messages };
    }
    if (step >= maxSteps || toolUses.length > MAX_TOOL_USES_PER_STEP) {
      // Budget used even after the "answer now" turn: drop the unanswered tool_use so the history stays valid.
      messages.pop();
      return { stop: "max_steps", text, steps: step, toolCalls, results, messages };
    }

    const answers: LLMContentBlock[] = [];
    for (const b of toolUses) {
      if (input.signal?.aborted) throw new LLMProviderError("aborted");
      const name = TOOL_NAME.test(b.name) ? b.name : "invalid";
      hooks.onToolStart?.({ name, toolUseId: b.id });
      // The one allowed proposal, once.
      const proposal = input.proposal && !proposalUsed && b.name === input.proposal.toolName ? input.proposal : undefined;
      // The server's laneId; the model's arguments go to the strict schema as they are.
      const out = await input.gate.call({
        laneId: input.laneId,
        toolName: b.name,
        toolUseId: b.id,
        args: b.input,
        ...(proposal ? { proposal } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      let record: ToolCallRecord;
      let content: string | null = null;
      if (out.ok) {
        if (out.tool.effect === "propose") proposalUsed = true;
        try {
          content = toolResultContent(out.tool, out.result);
        } catch {
          content = null;
        }
      }
      if (out.ok && content !== null) {
        record = { name, toolUseId: b.id, outcome: "ok", auditIncomplete: out.auditIncomplete };
        results.push({ tool: out.tool, toolUseId: b.id, result: out.result });
        answers.push({ type: "tool_result", toolUseId: b.id, content });
      } else {
        const reason: DenyReason = out.ok ? "tool_failed" : out.reason;
        record = { name, toolUseId: b.id, outcome: reason, auditIncomplete: false };
        // Fixed text only: nothing from the gate or the tool is forwarded.
        answers.push({ type: "tool_result", toolUseId: b.id, content: JSON.stringify({ error: DENY_MESSAGES[reason] }), isError: true });
      }
      toolCalls.push(record);
      hooks.onToolResult?.(record, out.ok ? out.result : null);
    }
    // Last allowed step next: ask for the answer instead of more tool calls (server text, after the results).
    if (step + 1 >= maxSteps) answers.push({ type: "text", text: FINAL_STEP_NOTE });
    messages.push({ role: "user", content: answers });
  }
}
