// Assistant chat (T-105 demo scope, approved by Saurabh Nov 8, 2026). POST /api/lanes/:laneId/assistant streams one
// answer as server-sent events. Order: body checks → AAL2 session + lane membership (guards) → provider configured →
// the caller's tool categories (core.ai_tool_categories) → runChatTurn (policy gate on every tool call, untrusted
// wrapping, no proposals). Nothing is stored (no conversations table yet); errors carry a code only, logs the class only.
import { chatRequestSchema, runChatTurn, type ChatEvent } from "@nichols/ai/chat";
import type { ProviderResult } from "@nichols/ai/config";
import { createPolicyGate, createToolRegistry, registerAssistantTools } from "@nichols/ai/tools";
import { LLMProviderError } from "@nichols/ai";
import type { Audit } from "@nichols/core/audit";
import { authErrorResponse, type Guards } from "@nichols/core/auth";

export const MAX_BODY_BYTES = 100_000;

export type ChatDeps = {
  guards: () => Promise<Pick<Guards, "requireSession" | "requireLane" | "listLanes">>;
  provider: () => ProviderResult;
  audit: () => Audit;
  now: () => Date;
};

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The tool categories the caller may use in the lane ([] when none or on any error: fail closed). */
export async function toolCategories(client: { schema: (s: "core") => { rpc: (fn: "ai_tool_categories", a: { p_lane: string }) => PromiseLike<{ data: unknown; error: unknown }> } }, laneId: string): Promise<string[]> {
  try {
    const { data, error } = await client.schema("core").rpc("ai_tool_categories", { p_lane: laneId });
    return !error && Array.isArray(data) ? data.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function errorCode(e: unknown): Extract<ChatEvent, { type: "error" }>["code"] {
  if (e instanceof LLMProviderError) {
    if (e.code === "aborted") return "aborted";
    if (e.code === "rate_limited" || e.code === "overloaded") return "rate_limited";
  }
  return "unavailable";
}

export async function handleChat(request: Request, laneId: string, deps: ChatDeps): Promise<Response> {
  const raw = await request.text().catch(() => "");
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) return json(400, { error: "invalid_request" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_request" });
  }
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid_request" });

  let g: Awaited<ReturnType<ChatDeps["guards"]>>;
  let client: Awaited<ReturnType<Guards["requireLane"]>>["client"];
  try {
    g = await deps.guards();
    ({ client } = await g.requireLane(laneId));
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    console.error("[assistant] unavailable:", e instanceof Error ? e.name : typeof e);
    return json(503, { error: "unavailable" });
  }

  const p = deps.provider();
  if (!p.configured) return json(503, { error: "not_configured" });
  const categories = await toolCategories(client as never, laneId);
  const laneName = (await g.listLanes().catch(() => [])).find((l) => l.laneId === laneId)?.name ?? laneId;

  const registry = registerAssistantTools(createToolRegistry(), deps.now);
  const gate = createPolicyGate({
    registry,
    audit: deps.audit(),
    requireSession: () => g.requireSession(),
    requireLane: (l) => g.requireLane(l),
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (e: ChatEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false;
        }
      };
      try {
        await runChatTurn({
          provider: p.provider,
          gate,
          registry,
          laneId,
          laneName,
          categories,
          request: parsed.data,
          now: deps.now(),
          emit,
          signal: request.signal,
        });
      } catch (e) {
        console.error("[assistant] turn failed:", e instanceof LLMProviderError ? e.code : e instanceof Error ? e.name : typeof e);
        emit({ type: "error", code: errorCode(e) });
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // already closed (client went away)
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
