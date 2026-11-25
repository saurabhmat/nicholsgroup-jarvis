// T-170 (security suite), area 5. The tools the assistant route REALLY offers the model are read at run time: the real `handleChat` is run with a
// mock provider that records the tool list of its request. A tool registered anywhere in the route's own code (apps/web/lib/assistant.ts), in a module
// or in the AI package shows up here and fails until it is classified. No regex over source.
import { describe, expect, it } from "vitest";
import { createMockProvider } from "@nichols/ai/testing";
import type { Audit } from "@nichols/core/audit";
import { handleChat, type ChatDeps } from "../lib/assistant";

const USER = "00000000-0000-4000-8000-000000000001";
const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
/** Every tool the assistant may offer today, with why it is safe. A new tool must be added here on purpose, after review (read effect, strict args, own_mail view). */
const OFFERED: Record<string, string> = {
  list_recent_mail: "read, mail metadata of the caller's own mailboxes, no bodies",
  list_meetings: "read, calendar metadata of the caller's own calendars",
};

describe("the assistant route's real tool list", () => {
  it("offers exactly the reviewed tools, to every category the lane allows (all six categories asked for)", async () => {
    const rpc = async (fn: string) =>
      fn === "ai_chat_turn" ? { data: { allowed: true, reason: null, categories: ["email", "calendar", "docs", "finance", "finance_summary", "tasks"] }, error: null } : { data: { allowed: true, reason: null, role: "owner" }, error: null };
    const client = { schema: () => ({ rpc }) };
    const provider = createMockProvider([{ status: "completed", stopReason: "end_turn", content: [{ type: "text", text: "ok" }], usage, model: "m", requestId: null, latencyMs: 0 }]);
    const audit: Audit = { log: async () => undefined };
    const deps: ChatDeps = {
      guards: async () => ({
        requireSession: async () => ({ userId: USER }) as never,
        requireLane: async () => ({ session: { userId: USER }, laneId: "PKG", client }) as never,
        listLanes: async () => [{ laneId: "PKG", name: "Synthetic Lane" }],
      }),
      provider: () => ({ configured: true, provider }),
      audit: () => audit,
      now: () => new Date("2026-11-24T15:00:00Z"),
    };
    const body = JSON.stringify({ messages: [{ role: "user", text: "What came in?" }] });
    const res = await handleChat(
      new Request("http://localhost/api/lanes/PKG/assistant", { method: "POST", body, headers: { "content-type": "application/json", "content-length": String(body.length), "sec-fetch-site": "same-origin" } }),
      "PKG",
      deps,
    );
    await res.text();
    const offered = provider.calls.flatMap((c) => (c.tools ?? []).map((t) => t.name)).sort();
    expect(offered.length).toBeGreaterThan(0);
    expect([...new Set(offered)]).toEqual(Object.keys(OFFERED).sort());
  });
});
