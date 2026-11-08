// Assistant chat (T-105 demo scope, approved by Saurabh Nov 8, 2026). POST /api/lanes/:laneId/assistant streams one
// answer as server-sent events. Order: same-origin JSON request with a bounded body → body schema → AAL2 session + lane
// membership (guards) → core.ai_chat_turn (role owner/finance_operator with the assistant view, non-empty categories,
// per-minute turn limit: before any model work) → provider configured → runChatTurn (policy gate on every tool call,
// untrusted wrapping, no proposals). Nothing is stored (no conversations table yet); errors carry a code only, logs
// the class only.
import { chatRequestSchema, runChatTurn, type ChatEvent } from "@nichols/ai/chat";
import type { ProviderResult } from "@nichols/ai/config";
import { createPolicyGate, createToolRegistry, registerAssistantTools } from "@nichols/ai/tools";
import { LLMProviderError } from "@nichols/ai";
import type { Audit } from "@nichols/core/audit";
import { createBrainStore, type ClientFor } from "@nichols/brain/server";
import { loadBrainPromptContext } from "@nichols/brain/server";
import { authErrorResponse, type Guards } from "@nichols/core/auth";

export const MAX_BODY_BYTES = 100_000;
/** Total history characters per request (cost bound; each turn may make up to 6 model calls). */
export const MAX_HISTORY_CHARS = 24_000;

type Rpc = { schema: (s: "core") => { rpc: (fn: string, a: { p_lane: string }) => PromiseLike<{ data: unknown; error: unknown }> } };

/** The chat-turn gate (core.ai_chat_turn). Any error fails closed as "unavailable". */
export async function takeChatTurn(client: Rpc, laneId: string): Promise<{ allowed: true; categories: string[] } | { allowed: false; reason: string }> {
  try {
    const { data, error } = await client.schema("core").rpc("ai_chat_turn", { p_lane: laneId });
    const v = (!error && data && typeof data === "object" ? data : {}) as { allowed?: unknown; reason?: unknown; categories?: unknown };
    if (v.allowed === true && Array.isArray(v.categories)) {
      const categories = v.categories.filter((c): c is string => typeof c === "string");
      if (categories.length > 0) return { allowed: true, categories };
    }
    return { allowed: false, reason: v.reason === "rate_limited" ? "rate_limited" : v.reason === "forbidden" || v.reason === "mfa_required" ? "forbidden" : "unavailable" };
  } catch {
    return { allowed: false, reason: "unavailable" };
  }
}

export type ChatDeps = {
  guards: () => Promise<Pick<Guards, "requireSession" | "requireLane" | "listLanes">>;
  provider: () => ProviderResult;
  audit: () => Audit;
  now: () => Date;
};

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The tool categories the caller may use in the lane ([] when none or on any error: fail closed). */
export async function toolCategories(client: Rpc, laneId: string): Promise<string[]> {
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
  // Same-origin JSON only (no cross-site simple POSTs), size known before reading.
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return json(403, { error: "forbidden" });
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: "invalid_request" });
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_BODY_BYTES) return json(400, { error: "invalid_request" });
  const raw = await request.text().catch(() => "");
  if (raw.length === 0 || new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json(400, { error: "invalid_request" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_request" });
  }
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid_request" });
  if (parsed.data.messages.reduce((n, m) => n + m.text.length, 0) > MAX_HISTORY_CHARS) return json(400, { error: "too_long" });

  let g: Awaited<ReturnType<ChatDeps["guards"]>>;
  let client: Awaited<ReturnType<Guards["requireLane"]>>["client"];
  let userId: string;
  try {
    g = await deps.guards();
    const lane = await g.requireLane(laneId);
    client = lane.client;
    userId = lane.session.userId;
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    console.error("[assistant] unavailable:", e instanceof Error ? e.name : typeof e);
    return json(503, { error: "unavailable" });
  }

  // Before any model work: who may chat here, with which tool categories, within the turn limit.
  const turn = await takeChatTurn(client as unknown as Rpc, laneId);
  if (!turn.allowed) {
    if (turn.reason === "rate_limited") return json(429, { error: "rate_limited" });
    if (turn.reason === "forbidden") return json(403, { error: "forbidden" });
    return json(503, { error: "unavailable" });
  }
  const categories = turn.categories;
  const p = deps.provider();
  if (!p.configured) return json(503, { error: "not_configured" });
  const laneName = (await g.listLanes().catch(() => [])).find((l) => l.laneId === laneId)?.name ?? laneId;

  // Brain context (T-212): the caller's own About-Me and Preferences (home lane, D-28) and this lane's own pages, read
  // through the session-bound lane client. Any failure only means fewer notes, never a failed turn. The employee
  // block belongs to employee runs (T-213), not to this chat.
  const g2 = g;
  const clientFor: ClientFor = async (l) => (await g2.requireLane(l)).client as never;
  const brainStore = createBrainStore({ clientFor, laneSettingsFor: async () => null });
  const brain = await loadBrainPromptContext(brainStore, { userId, lanes: [laneId] }).catch(() => null);

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
          userId,
          ...(brain ? { brain: { brainUser: brain.brainUser, laneBrain: brain.laneBrain } } : {}),
          onPrompt: (p) => {
            if (p.dropped.length || p.truncated.length) console.info("[assistant] brain blocks trimmed:", p.dropped.length, p.truncated.join(","));
          },
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
