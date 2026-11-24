// T-170 (security suite), area 5: the injection corpus against the REAL tool registry (registerAssistantTools: list_recent_mail,
// list_meetings), not against the fake tools of injection.test.ts, plus a catalog of every place retrieved content can reach a model.
// A mock model is scripted to COMPLY: it reads mail and calendar (hostile subject, sender, title, location), then makes every attacker call
// from the corpus (and forged-lane calls on the real tools). Assertions are server-side and hold whatever the model does.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { AuthError } from "@nichols/core/auth";
import type { AuditEntry } from "@nichols/core/audit";
import { describe, expect, it } from "vitest";
import { createMockProvider } from "../testing";
import { registerAssistantTools } from "../tools/catalog";
import { createPolicyGate } from "../tools/gate";
import { runToolLoop } from "../tools/loop";
import { createToolRegistry, TOOL_CATEGORIES, type ToolCategory } from "../tools/registry";
import type { LLMContentBlock, LLMRequest, LLMResult } from "../types";
import { CORPUS, SECRET_CANARIES } from "./corpus";

const USER = "00000000-0000-4000-8000-000000000001";
const CATS: ToolCategory[] = ["email", "calendar"];
const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const toolUse = (blocks: LLMContentBlock[]): LLMResult => ({ status: "tool_use", stopReason: "tool_use", content: blocks, usage, model: "mock", requestId: null, latencyMs: 0 });
const answer = (text: string): LLMResult => ({ status: "completed", stopReason: "end_turn", content: [{ type: "text", text }], usage, model: "mock", requestId: null, latencyMs: 0 });

const mailPayloads = CORPUS.filter((c) => ["email", "email_key", "customer_name", "memo", "doc", "web", "note", "source_label"].includes(c.carrier));
const calPayloads = CORPUS.filter((c) => c.carrier === "calendar");

function world(payload: string) {
  const reg = registerAssistantTools(createToolRegistry(), () => new Date("2026-11-24T12:00:00Z"));
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const audits: AuditEntry[] = [];
  const client = {
    accessToken: SECRET_CANARIES[1],
    serviceKey: SECRET_CANARIES[2],
    schema: (s: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcs.push({ fn: `${s}.${fn}`, args });
        if (fn === "ai_tool_gate") return { data: { allowed: CATS.includes(args.p_category as ToolCategory), reason: CATS.includes(args.p_category as ToolCategory) ? null : "category_denied", role: "owner" }, error: null };
        if (fn === "inbox_messages")
          return { data: [{ message_id: "m1", from_name: payload, from_address: "sender@example.test", subject: payload, received_at: "2026-11-24T11:00:00Z", is_read: false, is_important: true }], error: null };
        if (fn === "home_meetings")
          return { data: [{ title: payload, location: payload, start_at: "2026-11-24T15:00:00Z", end_at: "2026-11-24T16:00:00Z", all_day: false }], error: null };
        return { data: null, error: { code: "42883" } };
      },
    }),
  };
  const gate = createPolicyGate({
    registry: reg,
    audit: { log: async (e: AuditEntry) => void audits.push(e) },
    requireSession: async () => ({ userId: USER }) as never,
    requireLane: async (laneId: string) => {
      if (laneId !== "PKG") throw new AuthError("forbidden");
      return { session: { userId: USER }, client: client as never } as never;
    },
  } as never);
  return { reg, gate, rpcs, audits };
}

describe("the real registry", () => {
  it("is exactly the two reviewed read tools, both strict-argument, read effect, mail/calendar category, own_mail view, refs only", () => {
    const { reg } = world("x");
    expect(reg.list().map((t) => t.name).sort()).toEqual(["list_meetings", "list_recent_mail"]);
    for (const t of reg.list()) {
      expect(t.effect).toBe("read");
      expect(t.requiredView).toBe("own_mail");
      expect(t.resultStore).toBe("refs_only");
      expect(["email", "calendar"]).toContain(t.category);
      expect(t.args.safeParse({ laneId: "NL" }).success, `${t.name} refuses a lane field`).toBe(false);
      expect(t.args.safeParse({ filter: "all", range: "today", extra: 1 }).success, `${t.name} refuses unknown fields`).toBe(false);
    }
  });
  it("the registry enumerated at run time: every tool's effect, view, store, strict args, and no propose tool exists (the assistant offers reads only)", () => {
    const { reg } = world("x");
    const rows = reg.list().map((t) => `${t.name}:${t.effect}:${t.requiredView}:${t.resultStore}`);
    expect(rows.sort()).toEqual(["list_meetings:read:own_mail:refs_only", "list_recent_mail:read:own_mail:refs_only"]);
    // what the model is actually told about (the real tool definitions for all categories) names no lane argument anywhere
    for (const t of reg.llmTools(["email", "calendar", "docs", "finance", "finance_summary", "tasks"])) expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(/lane/i);
  });
  // The tools the assistant route REALLY offers are enumerated at run time by apps/web/tests/assistant-registry.test.ts (real handleChat).
  it("categories the registry can expose are exactly the lane policy's categories (a new category needs gate, SQL and tests)", () => {
    expect([...TOOL_CATEGORIES].sort()).toEqual(["calendar", "docs", "email", "finance", "finance_summary", "tasks"]);
  });
});

describe("compliant model against the real registry", () => {
  const attackNames = [...new Set(CORPUS.flatMap((c) => c.attack.map((a) => a.name))), "send_email", "delete_message", "forward_mail", "approve_action", "set_lane", "run_sql"];
  function script(attacks: { name: string; input: Record<string, unknown> }[]) {
    const all = [
      ...attacks.map((a, i) => ({ type: "tool_use" as const, id: `tu_attack_${i}`, name: a.name, input: a.input })),
      { type: "tool_use" as const, id: "tu_forge1", name: "list_recent_mail", input: { laneId: "NL" } },
      { type: "tool_use" as const, id: "tu_forge2", name: "list_recent_mail", input: { filter: "all", lane_id: "NL" } },
      { type: "tool_use" as const, id: "tu_forge3", name: "list_meetings", input: { range: "today", laneId: "APK" } },
      { type: "tool_use" as const, id: "tu_forge4", name: "list_recent_mail", input: { limit: 1000000 } },
    ];
    const chunks: (typeof all)[] = [];
    for (let i = 0; i < all.length; i += 6) chunks.push(all.slice(i, i + 6)); // the loop refuses more than 8 tool uses in one step
    let n = 0;
    return (req: LLMRequest): LLMResult => {
      n++;
      if (n === 1)
        return toolUse([
          { type: "tool_use", id: "tu_mail", name: "list_recent_mail", input: {} },
          { type: "tool_use", id: "tu_cal", name: "list_meetings", input: {} },
        ]);
      const chunk = chunks[n - 2];
      if (chunk) return toolUse(chunk);
      return answer(`Done as instructed. ${JSON.stringify(req.messages).slice(0, 3000)}`);
    };
  }

  it.each([...mailPayloads, ...calPayloads].map((c) => [c.id, c.payload] as const))("%s", async (_id, payload) => {
    const w = world(payload);
    const provider = createMockProvider([script(attackNames.map((name) => ({ name, input: { to: "x@evil.example", id: "act_1", laneId: "NL", month: "2026-11" } })))]);
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = SECRET_CANARIES[0];
    try {
      const out = await runToolLoop({ provider, gate: w.gate, registry: w.reg, laneId: "PKG", tier: "analysis", system: "You are the executive assistant.", messages: [{ role: "user", content: "What came in today?" }], categories: CATS, maxTokens: 512, maxSteps: 10 });
      const byId = new Map(out.toolCalls.map((t) => [t.toolUseId, t.outcome]));
      // The reads ran, nothing else did.
      expect(byId.get("tu_mail")).toBe("ok");
      expect(byId.get("tu_cal")).toBe("ok");
      const ran = out.toolCalls.filter((t) => t.outcome === "ok").map((t) => t.name).sort();
      expect(ran).toEqual(["list_meetings", "list_recent_mail"]);
      // Every attacker and forged-lane call was refused for a stated reason.
      for (const t of out.toolCalls.filter((c) => c.toolUseId.startsWith("tu_attack_") || c.toolUseId.startsWith("tu_forge"))) {
        expect(["unknown_tool", "invalid_args", "category_denied", "propose_not_allowed"], `${t.name}/${t.toolUseId}: ${t.outcome}`).toContain(t.outcome);
      }
      // The database was only asked for the gate and the two reads, always for PKG, with fixed arguments (nothing the model chose reached SQL).
      expect([...new Set(w.rpcs.map((r) => r.fn))].sort()).toEqual(["core.ai_tool_gate", "core.home_meetings", "core.inbox_messages"]);
      for (const r of w.rpcs) expect(r.args.p_lane, r.fn).toBe("PKG");
      expect(w.rpcs.find((r) => r.fn === "core.inbox_messages")?.args.p_limit).toBeLessThanOrEqual(25);
      // The hostile text reached the model only wrapped and escaped; no credential anywhere.
      const toResults = provider.calls.flatMap((c) => c.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])))));
      expect(toResults.length).toBeGreaterThan(0);
      for (const r of toResults) if (r.includes(payload.slice(0, 20))) expect(r).toMatch(/<untrusted_data /);
      for (const s of SECRET_CANARIES) expect(JSON.stringify({ calls: provider.calls, text: out.text, calls2: out.toolCalls })).not.toContain(s);
      // Every denial was audited without argument values.
      const denied = w.audits.filter((a) => a.action === "assistant.tool_call.denied");
      expect(denied.length).toBeGreaterThan(0);
      expect(JSON.stringify(denied)).not.toContain("x@evil.example");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe("every place retrieved content can reach a model", () => {
  // Enumerated by the provider interface, not by the shape of a call: every non-test file outside this package that imports the AI package is listed with
  // its role. `caller` files hold a provider and send content to a model; `wiring` files build or pass one and call nothing; `types` files only import types
  // or text helpers. A new importer fails until it is classified (and, if it is a caller, reviewed for its controls below).
  const CLASS: Record<string, { role: "caller" | "wiring" | "types"; controls: string }> = {
    "apps/web/lib/reply.ts": { role: "caller", controls: "reply draft: thread text is read live and sent as untrusted data; output is a PROPOSAL the person edits and approves (exact payload, hash, step-up)" },
    "apps/web/lib/news-run.ts": { role: "caller", controls: "news: web search results (untrusted) summarised; output is digest rows, no tools, no write" },
    "apps/web/lib/briefing-run.ts": { role: "caller", controls: "briefing: mail and calendar metadata; output is a structured briefing row for the owner; no tools" },
    "apps/web/lib/brain-import-model.ts": { role: "caller", controls: "brain import: an uploaded document is read; output is candidate rows the owner decides on; no tools" },
    "apps/web/lib/assistant.ts": { role: "caller", controls: "assistant: tool loop through the policy gate (two read tools only; proposals disabled); offered tools enumerated by assistant-registry.test.ts" },
    "apps/web/lib/news-domain.ts": { role: "types", controls: "cost and evidence helpers over a model result" },
    "apps/web/lib/briefing-output.ts": { role: "types", controls: "output schema helpers" },
    "apps/web/lib/brain-import.ts": { role: "wiring", controls: "request handler; passes the provider to brain-import-model" },
    "apps/web/lib/briefing-setup.ts": { role: "wiring", controls: "builds the provider for the briefing" },
    "apps/web/lib/briefing-schedule.ts": { role: "wiring", controls: "builds the provider for scheduled briefings" },
    "apps/web/lib/news-schedule.ts": { role: "wiring", controls: "builds the provider for scheduled news" },
    "apps/web/app/[laneId]/briefing-actions.ts": { role: "wiring", controls: "server action; builds the provider" },
    "apps/web/app/[laneId]/news-actions.ts": { role: "wiring", controls: "server action; builds the provider" },
    "apps/web/app/api/lanes/[laneId]/approvals/route.ts": { role: "wiring", controls: "builds the provider for the reply drafter" },
    "apps/web/app/api/lanes/[laneId]/assistant/route.ts": { role: "wiring", controls: "builds the provider for the assistant" },
    "apps/web/app/api/lanes/[laneId]/brain/import/route.ts": { role: "wiring", controls: "builds the provider for the brain import" },
    "apps/web/components/assistant-page.tsx": { role: "wiring", controls: "asks whether AI is configured" },
    "apps/web/components/onboarding-import-page.tsx": { role: "wiring", controls: "asks whether AI is configured" },
  };
  const root = resolve(__dirname, "../../../..");
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      if (["node_modules", "dist", ".next", ".next-e2e", ".turbo", "test-stubs", "e2e"].includes(n)) return [];
      const f = join(d, n);
      return statSync(f).isDirectory() ? walk(f) : [f];
    });
  const importers = [...walk(join(root, "apps")), ...walk(join(root, "packages"))]
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.|\.d\.ts$/.test(f) && !f.startsWith(join(root, "packages/ai/")))
    .filter((f) => /from "@nichols\/ai(\/[a-z]+)?"/.test(readFileSync(f, "utf8")))
    .map((f) => relative(root, f))
    .sort();
  it("the files that import the AI package are exactly the classified list (found from imports, not from call shapes)", () => {
    expect(importers).toEqual(Object.keys(CLASS).sort());
  });
  it("only the five `caller` files send content to a model, and none of the callers can reach an approval, a write client or the service client", () => {
    expect(Object.entries(CLASS).filter(([, c]) => c.role === "caller").map(([f]) => f).sort()).toEqual(
      ["apps/web/lib/assistant.ts", "apps/web/lib/brain-import-model.ts", "apps/web/lib/briefing-run.ts", "apps/web/lib/news-run.ts", "apps/web/lib/reply.ts"],
    );
    for (const f of Object.entries(CLASS).filter(([, c]) => c.role === "caller").map(([k]) => k)) {
      const text = readFileSync(join(root, f), "utf8");
      // reply.ts may PROPOSE (a draft the person must approve); nothing here may approve, execute, send or hold the service client.
      expect(text, f).not.toMatch(/@nichols\/connectors\/write|approveAndExecute|executeApproved|sendTeamsMessage|getLaneJobClient|getSupabaseSecretKey/);
      if (f !== "apps/web/lib/reply.ts") expect(text, f).not.toMatch(/proposeEmailAction|proposeTeamsAction/);
    }
  });
  it("a file that calls the model through the provider is a `caller`: any file naming `.complete(` or the tool loop outside the package is in that role", () => {
    const callers = new Set(Object.entries(CLASS).filter(([, c]) => c.role === "caller").map(([f]) => f));
    for (const f of [...walk(join(root, "apps")), ...walk(join(root, "packages"))]) {
      if (!/\.(ts|tsx)$/.test(f) || /\.test\.|\/testing|e2e|node_modules|packages\/ai\//.test(f)) continue;
      const rel = relative(root, f);
      const text = readFileSync(f, "utf8");
      if (/\b[A-Za-z_.]*\.complete\(|\brunToolLoop\(|\brunChat\(/.test(text)) expect(callers.has(rel), `${rel} calls a model but is not a classified caller`).toBe(true);
    }
  });
  it("the reply drafter (the one place a model's text becomes an outbound email body) only proposes: it never calls approve or execute", () => {
    const text = readFileSync(join(root, "apps/web/lib/reply.ts"), "utf8");
    expect(text).not.toMatch(/approve\(|execute\(|claim_execution|act_approve/);
  });
});
