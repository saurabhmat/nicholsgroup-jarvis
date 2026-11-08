import { describe, expect, it } from "vitest";
import { createMockProvider } from "@nichols/ai/testing";
import { LLMProviderError } from "@nichols/ai";
import { AuthError } from "@nichols/core/auth";
import type { Audit, AuditEntry } from "@nichols/core/audit";
import { handleChat, type ChatDeps } from "./assistant";

const USER = "00000000-0000-4000-8000-000000000001";
const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function deps(over: Partial<{ requireLane: () => Promise<unknown>; configured: boolean; turn: Record<string, unknown>; replies: Parameters<typeof createMockProvider>[0] }> = {}) {
  const audits: AuditEntry[] = [];
  const rpc = async (fn: string) => {
    if (fn === "ai_chat_turn") return { data: over.turn ?? { allowed: true, reason: null, categories: ["email", "calendar"] }, error: null };
    if (fn === "ai_tool_gate") return { data: { allowed: true, reason: null, role: "owner" }, error: null };
    if (fn === "inbox_messages")
      return { data: [{ message_id: "m_1", from_name: "Dana", subject: "Board pack", received_at: "2026-11-10T13:05:00Z", is_read: false, is_important: true }], error: null };
    return { data: [], error: null };
  };
  const client = { schema: () => ({ rpc }) };
  const provider = createMockProvider(
    over.replies ?? [
      { status: "tool_use", stopReason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "list_recent_mail", input: {} }], usage, model: "m", requestId: null, latencyMs: 0 },
      { status: "completed", stopReason: "end_turn", content: [{ type: "text", text: "Dana sent the board pack." }], usage, model: "m", requestId: null, latencyMs: 0 },
    ],
  );
  const audit: Audit = { log: async (e) => void audits.push(e) };
  const d: ChatDeps = {
    guards: async () => ({
      requireSession: async () => ({ userId: USER }) as never,
      requireLane: (over.requireLane as never) ?? (async () => ({ session: { userId: USER }, laneId: "PKG", client })),
      listLanes: async () => [{ laneId: "PKG", name: "Pub K Group" }],
    }),
    provider: () => (over.configured === false ? { configured: false, missing: ["ANTHROPIC_API_KEY"], refused: [] } : { configured: true, provider }),
    audit: () => audit,
    now: () => new Date("2026-11-10T15:00:00Z"),
  };
  return { d, provider, audits };
}

const req = (body: unknown, headers: Record<string, string> = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/api/lanes/PKG/assistant", {
    method: "POST",
    body: text,
    headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(text).length), "sec-fetch-site": "same-origin", ...headers },
  });
};
const good = { messages: [{ role: "user", text: "Anything important?" }] };

describe("assistant chat route", () => {
  it("rejects malformed bodies before touching the session", async () => {
    let touched = false;
    const { d } = deps({
      requireLane: async () => {
        touched = true;
        return {};
      },
    });
    for (const body of ["not json", { messages: [] }, { messages: [{ role: "user", text: "a" }], laneId: "NL" }, "x".repeat(100_001)]) {
      expect((await handleChat(req(body), "PKG", d)).status).toBe(400);
    }
    expect(touched).toBe(false);
  });

  it("returns 401/403 from the guards (AAL1, non-member)", async () => {
    expect((await handleChat(req(good), "PKG", deps({ requireLane: async () => Promise.reject(new AuthError("mfa_required")) }).d)).status).toBe(403);
    expect((await handleChat(req(good), "NL", deps({ requireLane: async () => Promise.reject(new AuthError("forbidden")) }).d)).status).toBe(403);
    expect((await handleChat(req(good), "PKG", deps({ requireLane: async () => Promise.reject(new AuthError("no_session")) }).d)).status).toBe(401);
  });

  it("says not_configured when the AI group is missing", async () => {
    const res = await handleChat(req(good), "PKG", deps({ configured: false }).d);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured" });
  });

  it("streams the answer with tool progress and in-app citations, audited", async () => {
    const { d, audits } = deps();
    const res = await handleChat(req(good), "PKG", d);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const events = text.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.split("\n")[1]?.slice(6) ?? "{}") as { type: string });
    expect(events.map((e) => e.type)).toEqual(["message.start", "tool.start", "tool.result", "text.delta", "citations", "grounding", "message.done"]);
    expect(text).toContain('"url":"/PKG/inbox/m_1"');
    expect(audits.map((a) => a.action)).toEqual(["assistant.tool_call.requested", "assistant.tool_call.succeeded"]);
  });

  it("refuses viewers, admin_technical, lanes without categories and rate-limited callers before any model call", async () => {
    for (const [turn, status] of [
      [{ allowed: false, reason: "forbidden", categories: [] }, 403],
      [{ allowed: false, reason: "mfa_required", categories: [] }, 403],
      [{ allowed: true, reason: null, categories: [] }, 503],
      [{ allowed: false, reason: "rate_limited", categories: [] }, 429],
    ] as const) {
      const { d, provider } = deps({ turn });
      expect((await handleChat(req(good), "PKG", d)).status).toBe(status);
      expect(provider.calls).toHaveLength(0);
    }
  });

  it("refuses cross-site, non-JSON, oversized and over-long requests", async () => {
    const { d, provider } = deps();
    expect((await handleChat(req(good, { "sec-fetch-site": "cross-site" }), "PKG", d)).status).toBe(403);
    expect((await handleChat(req(good, { "content-type": "text/plain" }), "PKG", d)).status).toBe(415);
    expect((await handleChat(req(good, { "content-length": "200000" }), "PKG", d)).status).toBe(400);
    const long = { messages: Array.from({ length: 7 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "x".repeat(3900) })) };
    expect((await handleChat(req(long), "PKG", d)).status).toBe(400);
    expect(provider.calls).toHaveLength(0);
  });

  it("sends an error event with a code only when the provider fails", async () => {
    const { d } = deps({ replies: [new LLMProviderError("rate_limited")] });
    const text = await (await handleChat(req(good), "PKG", d)).text();
    expect(text).toContain('"type":"error","code":"rate_limited"');
    expect(text).not.toContain("LLM provider error");
  });
});
