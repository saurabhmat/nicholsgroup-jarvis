import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthError } from "@nichols/core/auth";
import type { Audit, AuditEntry } from "@nichols/core/audit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPolicyGate, DENY_MESSAGES, type GateDeps } from "./gate";
import { createToolRegistry, ToolRegistrationError, type ToolDescriptor, type ToolResult } from "./registry";

const USER = "00000000-0000-4000-8000-000000000001";

function finTool(over: Partial<ToolDescriptor> = {}, runs: unknown[] = []): ToolDescriptor {
  return {
    name: "get_mrr",
    description: "Monthly recurring revenue (Stripe).",
    category: "finance",
    effect: "read",
    requiredView: "finance",
    args: z.strictObject({ month: z.string().regex(/^\d{4}-\d{2}$/) }),
    resultStore: "full",
    async run(ctx, args) {
      runs.push({ ctx, args });
      return { data: { display: "$12,345.00" }, sources: [{ kind: "stripe", id: "mrr" }], asOf: "2026-11-08T00:00:00Z", freshness: "cached", notes: [] } satisfies ToolResult<unknown>;
    },
    ...over,
  };
}

type RpcReply = { data: unknown; error: unknown } | Error;

function setup(opts: { rpc?: RpcReply; requireLane?: () => Promise<unknown>; auditFails?: boolean } = {}) {
  const registry = createToolRegistry();
  const runs: unknown[] = [];
  registry.register(finTool({}, runs));
  const audits: AuditEntry[] = [];
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const audit: Audit = {
    async log(e) {
      if (opts.auditFails) throw new Error("audit down");
      audits.push(e);
    },
  };
  const client = {
    schema: () => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        const r = opts.rpc ?? { data: { allowed: true, reason: null, role: "owner" }, error: null };
        if (r instanceof Error) throw r;
        return r;
      },
    }),
  };
  const deps: GateDeps = {
    registry,
    audit,
    requireLane: (opts.requireLane as GateDeps["requireLane"]) ?? (async () => ({ session: { userId: USER }, client: client as never })),
  };
  return { gate: createPolicyGate(deps), runs, audits, rpcCalls, registry };
}

const call = { laneId: "PKG", toolName: "get_mrr", toolUseId: "toolu_1", args: { month: "2026-11" } };

describe("tool registry", () => {
  it("registers a strict read tool and exposes a JSON schema without a lane field", () => {
    const r = createToolRegistry();
    r.register(finTool());
    const [t] = r.llmTools(["finance"]);
    expect(t?.name).toBe("get_mrr");
    expect(t?.inputSchema).toMatchObject({ type: "object", additionalProperties: false, required: ["month"] });
    expect(JSON.stringify(t?.inputSchema)).not.toMatch(/lane/i);
    expect(r.llmTools(["email"])).toEqual([]);
  });

  it.each([
    ["non-strict args", { args: z.object({ month: z.string() }) }],
    ["a lane field", { args: z.strictObject({ laneId: z.string() }) }],
    ["a nested lane field", { args: z.strictObject({ filter: z.strictObject({ lane: z.string() }).optional() }) }],
    ["a nested non-strict object", { args: z.strictObject({ filter: z.array(z.object({ a: z.string() })) }) }],
    ["a record (open keys)", { args: z.strictObject({ extra: z.record(z.string(), z.string()) }) }],
    ["a passthrough object", { args: z.looseObject({ a: z.string() }) }],
    ["a non-object schema", { args: z.string() }],
    ["an unknown effect", { effect: "write" as never }],
    ["an unknown category", { category: "drafting" as never }],
    ["an administration view", { requiredView: "memberships" as never }],
    ["a bad name", { name: "Get-MRR" }],
    ["no description", { description: " " }],
  ])("rejects %s", (_label, over) => {
    expect(() => createToolRegistry().register(finTool(over as Partial<ToolDescriptor>))).toThrow(ToolRegistrationError);
  });

  it("rejects duplicate names", () => {
    const r = createToolRegistry();
    r.register(finTool());
    expect(() => r.register(finTool())).toThrow(/duplicate/);
  });
});

describe("policy gate", () => {
  it("runs an allowed tool with the server's laneId, the user and role, and audits requested + succeeded", async () => {
    const { gate, runs, audits, rpcCalls } = setup();
    const out = await gate.call(call);
    expect(out.ok).toBe(true);
    expect(runs).toEqual([{ ctx: { laneId: "PKG", userId: USER, role: "owner" }, args: { month: "2026-11" } }]);
    expect(rpcCalls).toEqual([
      { fn: "ai_tool_gate", args: { p_lane: "PKG", p_view: "finance", p_category: "finance", p_limit: 30, p_window_seconds: 60 } },
    ]);
    expect(audits.map((a) => a.action)).toEqual(["assistant.tool_call.requested", "assistant.tool_call.succeeded"]);
    expect(audits[0]).toMatchObject({ laneId: "PKG", actor: { kind: "user", userId: USER }, target: "tool:get_mrr" });
  });

  it("rejects a forged laneId or extra argument and audits it; the tool never runs", async () => {
    for (const args of [{ month: "2026-11", laneId: "NL" }, { month: "2026-11", lane_id: "NL" }, { month: "x" }, null, "2026-11"]) {
      const { gate, runs, audits } = setup();
      const out = await gate.call({ ...call, args });
      expect(out).toEqual({ ok: false, reason: "invalid_args", message: DENY_MESSAGES.invalid_args });
      expect(runs).toHaveLength(0);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "assistant.tool_call.denied", metadata: { reason: "invalid_args" } });
      expect(JSON.stringify(audits)).not.toContain("NL");
    }
  });

  it("denies a lane the user is not a member of (lane router refuses) and audits it", async () => {
    const { gate, runs, audits } = setup({ requireLane: async () => Promise.reject(new AuthError("forbidden")) });
    const out = await gate.call({ ...call, laneId: "NL" });
    expect(out).toMatchObject({ ok: false, reason: "not_member", message: "Not available in this lane." });
    expect(runs).toHaveLength(0);
    expect(audits[0]).toMatchObject({ laneId: "NL", action: "assistant.tool_call.denied", actor: { kind: "system" } });
  });

  it("maps AAL1 and missing sessions", async () => {
    for (const [err, reason] of [[new AuthError("mfa_required"), "mfa_required"], [new AuthError("no_session"), "no_session"], [new Error("boom"), "gate_unavailable"]] as const) {
      const { gate } = setup({ requireLane: async () => Promise.reject(err) });
      expect(await gate.call(call)).toMatchObject({ ok: false, reason });
    }
  });

  it.each([
    ["category_denied", "Not available in this lane."],
    ["view_denied", "Not available for your role."],
    ["role_denied", "Not available for your role."],
    ["lane_disabled", "Not available in this lane."],
    ["rate_limited", "Too many tool calls; try again shortly."],
    ["mfa_required", "Not available: two-factor sign-in is required."],
  ])("returns the database denial %s to the model, audited, without running", async (reason, message) => {
    const { gate, runs, audits } = setup({ rpc: { data: { allowed: false, reason, role: "viewer" }, error: null } });
    expect(await gate.call(call)).toEqual({ ok: false, reason, message });
    expect(runs).toHaveLength(0);
    expect(audits).toEqual([expect.objectContaining({ action: "assistant.tool_call.denied", metadata: expect.objectContaining({ reason }) })]);
  });

  it("denies viewer and admin_technical even if the database answer were wrong about them", async () => {
    for (const role of ["admin_technical", "viewer", "superuser", null]) {
      const { gate, runs } = setup({ rpc: { data: { allowed: true, reason: null, role }, error: null } });
      expect(await gate.call(call)).toMatchObject({ ok: false, reason: "role_denied" });
      expect(runs).toHaveLength(0);
    }
  });

  it("fails closed on database errors and odd replies", async () => {
    for (const rpc of [{ data: null, error: { message: "x" } }, { data: [], error: null }, { data: { allowed: "yes" }, error: null }, { data: { allowed: false, reason: "made_up" }, error: null }, new Error("net")]) {
      const { gate, runs } = setup({ rpc });
      expect(await gate.call(call)).toMatchObject({ ok: false, reason: "gate_unavailable" });
      expect(runs).toHaveLength(0);
    }
  });

  it("denies unknown tools without asking the database", async () => {
    const { gate, rpcCalls, audits } = setup();
    expect(await gate.call({ ...call, toolName: "send_email" })).toMatchObject({ ok: false, reason: "unknown_tool" });
    expect(rpcCalls).toHaveLength(0);
    expect(audits[0]).toMatchObject({ target: "tool:unknown" });
  });

  it("never runs a tool when the audit write fails, and never throws", async () => {
    const { gate, runs } = setup({ auditFails: true });
    expect(await gate.call(call)).toMatchObject({ ok: false, reason: "tool_failed" });
    expect(runs).toHaveLength(0);
  });

  it("returns tool_failed when the tool throws, with no error text", async () => {
    const { gate, registry, audits } = setup();
    registry.register(finTool({ name: "boom", run: async () => Promise.reject(new Error("SECRET-DB-ROW")) }));
    const out = await gate.call({ ...call, toolName: "boom" });
    expect(out).toEqual({ ok: false, reason: "tool_failed", message: DENY_MESSAGES.tool_failed });
    expect(audits.map((a) => a.action)).toEqual(["assistant.tool_call.requested", "assistant.tool_call.failed"]);
    expect(JSON.stringify([out, audits])).not.toContain("SECRET");
  });

  it("sanitizes a hostile toolUseId before auditing", async () => {
    const { gate, audits } = setup();
    await gate.call({ ...call, toolUseId: "x'; drop table--" });
    expect(audits[0]?.metadata).toMatchObject({ tool_use_id: "invalid" });
  });
});

// ---------------------------------------------------------------- registration scan (spec §4)
// Tool sources: packages/ai/src/tools and every module's src/tools. A tool may not reach a write path; a propose tool
// may only use approvals' proposeAction.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FORBIDDEN: [RegExp, string][] = [
  [/@nichols\/connectors\/write|connectors\/src\/write/, "connector write path"],
  [/\bexecuteWrite\b/, "executeWrite"],
  [/\bgetLaneJobClient\b|\bcreateLaneRouter\b/, "service client"],
  [/\.(insert|upsert|update|delete)\s*\(/, "direct table write"],
  [/\.rpc\(\s*["'][a-z_]*(save|put|upsert|apply|store|rotate|revoke|purge|write|delete|insert|update|normalize)[a-z_]*["']/, "writer RPC"],
];

export function toolSourceProblems(src: string): string[] {
  const out = FORBIDDEN.filter(([re]) => re.test(src)).map(([, why]) => why);
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']@nichols\/approvals[^"']*["']/g)) {
    const names = (m[1] ?? "").split(",").map((n) => n.trim().split(/\s+as\s+/)[0]?.replace(/^type\s+/, "")).filter(Boolean);
    if (names.some((n) => n !== "proposeAction")) out.push("approvals import other than proposeAction");
  }
  if (/from\s+["']@nichols\/approvals\/(?!index)/.test(src)) out.push("approvals internals");
  return out;
}

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) ? [p] : [];
  });
}

describe("tool registration scan", () => {
  it("catches each forbidden pattern (scanner self-test)", () => {
    expect(toolSourceProblems(`import { executeWrite } from "@nichols/connectors/write";`)).toEqual(
      expect.arrayContaining(["connector write path", "executeWrite"]),
    );
    expect(toolSourceProblems(`await client.schema("fin").from("x").insert({})`)).toContain("direct table write");
    expect(toolSourceProblems(`await client.schema("core").rpc("brain_document_save", {})`)).toContain("writer RPC");
    expect(toolSourceProblems(`import { proposeAction, executeAction } from "@nichols/approvals";`)).toContain(
      "approvals import other than proposeAction",
    );
    expect(toolSourceProblems(`import { proposeAction } from "@nichols/approvals";`)).toEqual([]);
    expect(toolSourceProblems(`await client.schema("core").rpc("home_meetings", {})`)).toEqual([]);
  });

  it("no tool source reaches a write path", () => {
    const modules = path.join(root, "packages/modules");
    const dirs = [path.join(root, "packages/ai/src/tools"), ...readdirSync(modules).map((m) => path.join(modules, m, "src/tools"))];
    const files = dirs.flatMap(walk);
    expect(files.length).toBeGreaterThan(0);
    const bad = files.flatMap((f) => toolSourceProblems(readFileSync(f, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "")).map((p) => `${path.relative(root, f)}: ${p}`));
    expect(bad).toEqual([]);
  });
});
