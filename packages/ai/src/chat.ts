// Assistant chat turn (T-105, demo scope approved by Saurabh Nov 8, 2026). Framework-free: the route handler in
// apps/web wires the session, lane client, audit and SSE; this file validates the history, builds the system prompt,
// runs the reviewed tool loop (runToolLoop: gate, wrapping, proposals off) and turns it into events.
// Not stored anywhere (T-103 conversations storage is not built): the page keeps the conversation in memory.
// History comes from the browser as plain text only: earlier tool results are never replayed (T-102 sec L5), and
// nothing in it can change tools, lanes or roles (the gate decides server-side).
import { z } from "zod";
import type { LaneId } from "@nichols/core";
import { runToolLoop, type ToolLoopResult } from "./tools/loop";
import type { PolicyGate } from "./tools/gate";
import type { ToolCategory, ToolRegistry } from "./tools/registry";
import { TOOL_CATEGORIES } from "./tools/registry";
import type { LLMMessage, LLMProvider, LLMSystemBlock } from "./types";
import { assemblePrompt, withUserContext, type AssembledPrompt, type PromptInput } from "./prompts";

export const MAX_TURNS = 20;
export const MAX_TURN_CHARS = 4000;

export const chatRequestSchema = z.strictObject({
  messages: z
    .array(z.strictObject({ role: z.enum(["user", "assistant"]), text: z.string().trim().min(1).max(MAX_TURN_CHARS) }))
    .min(1)
    .max(MAX_TURNS)
    .refine((m) => m.every((t, i) => t.role === (i % 2 === 0 ? "user" : "assistant")) && m[m.length - 1]?.role === "user", {
      message: "turns must alternate, starting and ending with the user",
    }),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export type Citation = { kind: string; label: string; url: string | null; asOf: string; freshness: "live" | "cached" | "stale"; tool: string };
export type Grounding = { status: "passed" | "failed" | "not_applicable"; unverified: string[] };

export type ChatEvent =
  | { type: "message.start" }
  | { type: "text.delta"; text: string }
  | { type: "tool.start"; tool: string }
  | { type: "tool.result"; tool: string; outcome: string }
  | { type: "citations"; citations: Citation[] }
  | { type: "grounding"; grounding: Grounding }
  | { type: "message.done"; stop: ToolLoopResult["stop"] }
  | { type: "error"; code: "not_configured" | "unavailable" | "rate_limited" | "aborted" };

/**
 * System prompt through the shared assembly (T-212): rules, runtime facts, and (when passed) the owner's brain blocks.
 * Returns the blocks and the `<user_preferences>` text for the first user message (null for the chat today).
 */
export type BrainArgs = Pick<PromptInput, "brainUser" | "laneBrain" | "employee" | "brainNotes">;
/** Brain context is only accepted together with the signed-in user's id (D-28 is checked against it). */
export type WithBrain = { userId: string; brain?: BrainArgs } | { userId?: string; brain?: undefined };

export function chatSystemPrompt(input: {
  laneId: LaneId;
  laneName: string;
  now: Date;
  categories: readonly ToolCategory[];
} & WithBrain): LLMSystemBlock[] {
  return assembleChatPrompt(input).system;
}

export function assembleChatPrompt(input: Parameters<typeof chatSystemPrompt>[0]): AssembledPrompt {
  return assemblePrompt({
    laneIds: [input.laneId],
    laneNames: { [input.laneId]: input.laneName },
    now: input.now,
    categories: input.categories,
    subjectUserId: input.userId ?? "anonymous",
    ...(input.brain ?? {}),
  });
}

// Money amounts and percentages only (counts, times and dates are not checked).
const FIGURE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d+(?:\.\d+)?\s?%/g;
const value = (s: string) => {
  const n = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? String(n) : s;
};

/**
 * Numeric grounding (rule 7): every money amount or percentage in the answer must appear, as a money amount or
 * percentage, in this turn's tool data or in the conversation the user sent (a figure repeated from earlier). Ids,
 * timestamps and other digit runs never count as support. Flagged only; retry-and-replace is still open (T-105).
 */
export function checkGrounding(answer: string, results: ToolLoopResult["results"], history = ""): Grounding {
  const figures = [...new Set(answer.match(FIGURE) ?? [])];
  if (figures.length === 0) return { status: "not_applicable", unverified: [] };
  const sources = `${JSON.stringify(results.map((r) => r.result.data))} ${history}`;
  const known = new Set((sources.match(FIGURE) ?? []).map((f) => `${f.includes("%") ? "%" : "$"}${value(f)}`));
  const unverified = figures.filter((f) => !known.has(`${f.includes("%") ? "%" : "$"}${value(f)}`));
  return { status: unverified.length ? "failed" : "passed", unverified };
}

export function citationsOf(results: ToolLoopResult["results"]): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    for (const s of r.result.sources) {
      const key = `${s.kind}:${s.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: s.kind, label: s.label ?? s.kind, url: s.url ?? null, asOf: r.result.asOf, freshness: r.result.freshness, tool: r.tool.name });
    }
  }
  return out.slice(0, 20);
}

export async function runChatTurn(input: {
  provider: LLMProvider;
  gate: PolicyGate;
  registry: ToolRegistry;
  laneId: LaneId;
  laneName: string;
  categories: readonly string[];
  request: ChatRequest;
  now: Date;
  emit: (e: ChatEvent) => void;
  signal?: AbortSignal;
  maxTokens?: number;
  /** Receives the assembly result (dropped pages etc.) for the run log. */
  onPrompt?: (p: Pick<AssembledPrompt, "blocks" | "dropped" | "truncated" | "brainTokens">) => void;
} & WithBrain): Promise<void> {
  const categories = input.categories.filter((c): c is ToolCategory => (TOOL_CATEGORIES as readonly string[]).includes(c));
  // Defence in depth: the route refuses callers without categories before this; never call the model for them.
  if (categories.length === 0) throw new Error("no assistant categories for this caller");
  const prompt = assembleChatPrompt({
    laneId: input.laneId,
    laneName: input.laneName,
    now: input.now,
    categories,
    ...(input.brain ? { userId: input.userId, brain: input.brain } : input.userId ? { userId: input.userId } : {}),
  } as Parameters<typeof assembleChatPrompt>[0]);
  input.onPrompt?.({ blocks: prompt.blocks, dropped: prompt.dropped, truncated: prompt.truncated, brainTokens: prompt.brainTokens });
  const messages = withUserContext(
    input.request.messages.map((m): LLMMessage => ({ role: m.role, content: m.text })),
    prompt.userContext,
  );
  input.emit({ type: "message.start" });
  let wrote = false;
  const out = await runToolLoop({
    provider: input.provider,
    gate: input.gate,
    registry: input.registry,
    laneId: input.laneId,
    tier: "analysis",
    system: prompt.system,
    messages,
    categories,
    maxTokens: input.maxTokens ?? 2048,
    maxSteps: 6,
    ...(input.signal ? { signal: input.signal } : {}),
    hooks: {
      // Each model step's text is a separate paragraph (a short preamble before a tool call must not run into the answer).
      onText: (text) => {
        input.emit({ type: "text.delta", text: wrote ? `\n\n${text}` : text });
        wrote = true;
      },
      onToolStart: (c) => input.emit({ type: "tool.start", tool: c.name }),
      onToolResult: (c) => input.emit({ type: "tool.result", tool: c.name, outcome: c.outcome }),
    },
  });
  input.emit({ type: "citations", citations: citationsOf(out.results) });
  const history = input.request.messages.map((m) => m.text).join("\n");
  input.emit({ type: "grounding", grounding: checkGrounding(out.text, out.results, history) });
  input.emit({ type: "message.done", stop: out.stop });
}
