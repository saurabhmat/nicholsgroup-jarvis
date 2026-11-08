import { describe, expect, it } from "vitest";
import { assemblePrompt } from "@nichols/ai/prompts";
import { createMockProvider } from "@nichols/ai/testing";
import { employeeConfigSchema } from "@nichols/brain";
import { buildEmployeePrompt } from "@nichols/brain/server";
import { handleChat, type ChatDeps } from "./assistant";

const ME = "00000000-0000-4000-8000-000000000001";
const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

describe("employee prompt chain (T-212)", () => {
  it("include/topics are absent from the system text and present in userContext", async () => {
    const config = employeeConfigSchema.parse({ lanes: ["PKG"], sources: { mail: [{ lane: "PKG", mailbox: "boss@example.test", priority: 1, include: ["INCLUDEME"] }], external: [{ kind: "web_news", topics: ["TOPICME"] }] } });
    const b = await buildEmployeePrompt(
      { isMine: true, laneId: "PKG", roleKey: "personal_assistant", name: "PA", instructions: "Be brief", config: config as never },
      "PKG",
      ME,
      {
        loadEmployeeConfig: async () => config,
        policyFor: () => ({ write_actions_allowed: ["email_draft"], store_outbound_drafts: true }),
        roleFor: () => "owner",
        laneSettingsFor: () => ({ mailboxes: [], kpis: [] }),
      },
    );
    const p = assemblePrompt({
      laneIds: ["PKG"],
      now: new Date("2026-11-10T15:00:00Z"),
      categories: ["email"],
      subjectUserId: ME,
      employee: { ownerUserId: b.ownerUserId, roleKey: b.roleKey, name: b.name, instructions: b.instructions, summary: b.summary, userPreferences: b.userPreferences },
    });
    expect(p.system.map((x) => x.text).join("\n")).not.toMatch(/INCLUDEME|TOPICME/);
    expect(p.userContext).toMatch(/INCLUDEME/);
    expect(p.userContext).toMatch(/TOPICME/);
  });
});

describe("assistant route brain wiring (T-212)", () => {
  type Fail = "none" | "home" | "hang";
  function setup(fail: Fail = "none") {
    const lanesAsked: string[] = [];
    const docs: Record<string, Record<string, { kind: string; body: string }>> = {
      HOME: { "Context/About-Me.md": { kind: "about_me", body: "ABOUTME-TEXT" } },
      PKG: { "Context/Work.md": { kind: "context", body: "PKG-WORK" } },
      NL: { "Context/Work.md": { kind: "context", body: "NL-WORK-MUST-NOT-APPEAR" } },
    };
    const clientFor = (lane: string) => ({
      schema: () => ({
        rpc: async (fn: string, a: Record<string, unknown>) => {
          if (fn === "ai_chat_turn") return { data: { allowed: true, reason: null, categories: ["email"] }, error: null };
          if (fn === "brain_home_lane") {
            if (fail === "home") return { data: null, error: { message: "boom" } };
            if (fail === "hang") return new Promise(() => undefined);
            return { data: "HOME", error: null };
          }
          const laneDocs = docs[String(a.p_lane)] ?? {};
          if (fn === "brain_documents_list") return { data: Object.entries(laneDocs).map(([path, d]) => ({ path, kind: d.kind, version: 1, updated_at: "2026-11-01T00:00:00Z", is_mine: true })), error: null };
          if (fn === "brain_document_get") {
            const d = laneDocs[String(a.p_path)];
            return { data: d ? [{ id: "i", path: a.p_path, kind: d.kind, body_md: d.body, version: 1, updated_at: "2026-11-01T00:00:00Z", is_mine: true }] : [], error: null };
          }
          return { data: [], error: null };
        },
      }),
      lane,
    });
    const provider = createMockProvider([{ status: "completed", stopReason: "end_turn", content: [{ type: "text", text: "Hello." }], usage, model: "m", requestId: null, latencyMs: 0 }]);
    const d: ChatDeps = {
      guards: async () => ({
        requireSession: async () => ({ userId: ME }) as never,
        requireLane: async (l: string) => {
          lanesAsked.push(l);
          if (l !== "PKG" && l !== "HOME") throw new Error("forbidden");
          return { session: { userId: ME }, laneId: l, client: clientFor(l) } as never;
        },
        listLanes: async () => [{ laneId: "PKG", name: "Pub K Group" }],
      }),
      provider: () => ({ configured: true, provider }),
      audit: () => ({ log: async () => undefined }),
      now: () => new Date("2026-11-10T15:00:00Z"),
      brainTimeoutMs: 100,
    };
    return { d, provider, lanesAsked };
  }
  const post = (d: ChatDeps) => {
    const body = JSON.stringify({ messages: [{ role: "user", text: "hi" }] });
    return handleChat(
      new Request("http://localhost/api/lanes/PKG/assistant", { method: "POST", body, headers: { "content-type": "application/json", "content-length": String(body.length), "sec-fetch-site": "same-origin" } }),
      "PKG",
      d,
    );
  };

  it("opens only the request lane and the home lane; only the request lane's block; About-Me from the home lane", async () => {
    const s = setup();
    const res = await post(s.d);
    expect(await res.text()).toContain("message.done");
    expect([...new Set(s.lanesAsked)].sort()).toEqual(["HOME", "PKG"]);
    const sys = JSON.stringify(s.provider.calls[0]?.system);
    expect(sys).toContain('<brain_lane lane=\\"PKG\\">');
    expect(sys).not.toContain('lane=\\"NL\\"');
    expect(sys).not.toContain("NL-WORK-MUST-NOT-APPEAR");
    expect(sys).toContain("ABOUTME-TEXT");
    expect(sys).toContain("PKG-WORK");
  });

  it("a home-lane failure still gives a normal turn, with a note", async () => {
    const s = setup("home");
    const res = await post(s.d);
    expect(await res.text()).toContain("message.done");
    const sys = JSON.stringify(s.provider.calls[0]?.system);
    expect(sys).toContain("could not be loaded");
    expect(sys).not.toContain("ABOUTME-TEXT");
    expect(sys).toContain("PKG-WORK");
  });

  it("a hung brain load times out and the turn goes on without brain context", async () => {
    const s = setup("hang");
    const res = await post(s.d);
    expect(await res.text()).toContain("message.done");
    const sys = JSON.stringify(s.provider.calls[0]?.system);
    expect(sys).toContain("could not be loaded");
    expect(sys).not.toContain("PKG-WORK");
  });
});
