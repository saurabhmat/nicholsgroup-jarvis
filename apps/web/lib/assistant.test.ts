import { describe, expect, it } from "vitest";
import { createMockProvider } from "@nichols/ai/testing";
import { AuthError } from "@nichols/core/auth";
import type { Audit, AuditEntry } from "@nichols/core/audit";
import { handleChat, type ChatDeps } from "./assistant";

const USER = "00000000-0000-4000-8000-000000000001";
const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function deps(over: Partial<{ requireLane: () => Promise<unknown>; configured: boolean; categories: string[]; replies: Parameters<typeof createMockProvider>[0] }> = {}) {
  const audits: AuditEntry[] = [];
  const rpc = async (fn: string) => {
    if (fn === "ai_tool_categories") return { data: over.categories ?? ["email", "calendar"], error: null };
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

const req = (body: unknown) => new Request("http://localhost/api/lanes/PKG/assistant", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
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
    for (const body of ["", "not json", { messages: [] }, { messages: [{ role: "user", text: "a" }], laneId: "NL" }, "x".repeat(100_001)]) {
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

  it("offers no tools when the caller has no categories", async () => {
    const { d, provider } = deps({ categories: [], replies: [{ status: "completed", stopReason: "end_turn", content: [{ type: "text", text: "I can't read that here." }], usage, model: "m", requestId: null, latencyMs: 0 }] });
    await (await handleChat(req(good), "PKG", d)).text();
    expect(provider.calls[0]?.tools).toBeUndefined();
  });
});
