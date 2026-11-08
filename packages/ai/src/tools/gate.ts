// Policy gate (T-101, docs/specs/assistant.md §3, §4): the only way a tool runs. Order:
//   1. AAL2 session                    guards.requireSession (no session / mfa required), before anything else
//   2. membership and role             guards.requireLane (member of an enabled, served lane) + core.ai_tool_gate
//   3. lane enabled                    core.ai_tool_gate
//   4. llm_allowed_categories          core.ai_tool_gate
//   5. 'assistant' + required view     core.ai_tool_gate
//   6. rate limit                      core.ai_tool_gate (atomic, per lane and user; limit from lane_config)
//   7. strict argument parse           the descriptor's schema (a forged laneId or extra field fails here)
//   8. run + audit                     requested -> succeeded | failed; the tool gets the user's lane client
// laneId comes from the server (the conversation), never from model output. Every call is audited, denied ones with
// the reason only (no argument values). Denials are returned as a structured outcome for the model; they never throw.
import type { Audit } from "@nichols/core/audit";
import type { LaneId } from "@nichols/core";
import { AuthError, type Role } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import { toolResultSchema, type ToolDescriptor, type ToolRegistry, type ToolResult } from "./registry";

export type DenyReason =
  | "unknown_tool"
  | "no_session"
  | "mfa_required"
  | "not_member"
  | "role_denied"
  | "lane_disabled"
  | "category_denied"
  | "view_denied"
  | "rate_limited"
  | "invalid_args"
  | "gate_unavailable"
  | "tool_failed"
  | "propose_not_allowed";

/** The text the model sees for a denial: short, fixed, no internals. */
export const DENY_MESSAGES: Record<DenyReason, string> = {
  unknown_tool: "That tool does not exist.",
  no_session: "Not available: the session has ended.",
  mfa_required: "Not available: two-factor sign-in is required.",
  not_member: "Not available in this lane.",
  role_denied: "Not available for your role.",
  lane_disabled: "Not available in this lane.",
  category_denied: "Not available in this lane.",
  view_denied: "Not available for your role.",
  rate_limited: "Too many tool calls; try again shortly.",
  invalid_args: "The tool arguments were not valid.",
  gate_unavailable: "The tool is temporarily unavailable.",
  tool_failed: "The tool failed; no data was returned.",
  propose_not_allowed: "Proposals can only be made when the user asks for one directly.",
};

export type GateCall = {
  laneId: LaneId;
  toolName: string;
  toolUseId: string;
  args: unknown;
  /**
   * The one proposal the user's explicit action allows (never from model output): that tool only, and only with
   * arguments the server-side check accepts (e.g. recipients resolved from the thread the user picked).
   */
  proposal?: AllowedProposal;
  signal?: AbortSignal;
};

export type AllowedProposal = { toolName: string; check(args: unknown): boolean };

export type GateOutcome =
  | {
      ok: true;
      tool: ToolDescriptor;
      /** The validated arguments (for ai.tool_calls, T-103). */
      args: unknown;
      result: ToolResult<unknown>;
      durationMs: number;
      /** The run completed but the final audit write failed (the requested entry exists). */
      auditIncomplete: boolean;
    }
  | { ok: false; reason: DenyReason; message: string };

export type GateDeps = {
  registry: ToolRegistry;
  /** guards.requireSession from @nichols/core/auth (AAL2). */
  requireSession(): Promise<{ userId: string }>;
  /** guards.requireLane from @nichols/core/auth: AAL2 session + membership of an enabled lane, user client. */
  requireLane(laneId: LaneId): Promise<{ session: { userId: string }; client: LaneClient }>;
  audit: Audit;
  now?: () => number;
};

export type PolicyGate = { call(input: GateCall): Promise<GateOutcome> };

const GATE_REASONS = new Set<DenyReason>(["mfa_required", "not_member", "role_denied", "lane_disabled", "category_denied", "view_denied", "rate_limited"]);
// Roles that hold the 'assistant' view (core.role_views). Checked again here so a wrong database answer cannot hand a
// viewer or admin_technical a content tool.
const ROLES = new Set<Role>(["owner", "finance_operator"]);
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const LANE_ID = /^[A-Z]{1,8}$/;

function authReason(e: unknown): DenyReason | null {
  if (!(e instanceof AuthError)) return null;
  if (e.reason === "no_session") return "no_session";
  if (e.reason === "mfa_required") return "mfa_required";
  return "not_member";
}

export function createPolicyGate(deps: GateDeps): PolicyGate {
  const now = deps.now ?? Date.now;
  const denyOut = (reason: DenyReason): GateOutcome => ({ ok: false, reason, message: DENY_MESSAGES[reason] });

  return {
    async call(input) {
      const toolUseId = typeof input.toolUseId === "string" && TOOL_USE_ID.test(input.toolUseId) ? input.toolUseId : "invalid";

      // 1. Session first, so every later denial is audited against the user who attempted it.
      let userId: string;
      try {
        userId = (await deps.requireSession()).userId;
      } catch (e) {
        // No authenticated user: nothing to attribute, and no lane to trust. Not audited (the auth layer logs sign-in).
        return denyOut(authReason(e) ?? "gate_unavailable");
      }
      // A malformed laneId cannot be audited (audit schema) and is never a lane: refuse before anything else.
      if (typeof input.laneId !== "string" || !LANE_ID.test(input.laneId)) return denyOut("not_member");
      const laneId = input.laneId;

      const tool = typeof input.toolName === "string" ? deps.registry.get(input.toolName) : undefined;
      const target = tool ? `tool:${tool.name}` : "tool:unknown";
      const deny = async (reason: DenyReason): Promise<GateOutcome> => {
        // Audited with the reason only. A failed audit write must not turn a denial into an exception for the UI.
        await deps.audit
          .log({
            laneId,
            actor: { kind: "user", userId },
            action: "assistant.tool_call.denied",
            target,
            metadata: { reason, tool_use_id: toolUseId, ...(tool ? { category: tool.category, effect: tool.effect } : {}) },
          })
          .catch(() => undefined);
        return denyOut(reason);
      };

      // 2. Membership of an enabled lane, and the user's own client for it.
      let client: LaneClient;
      try {
        const ctx = await deps.requireLane(laneId);
        if (ctx.session.userId !== userId) return deny("gate_unavailable");
        client = ctx.client;
      } catch (e) {
        return deny(authReason(e) ?? "gate_unavailable");
      }
      if (!tool) return deny("unknown_tool");

      // 2-6. Role, lane enabled, category, views and rate limit, for this user, in the database.
      let role: Role;
      try {
        const { data, error } = await client.schema("core").rpc("ai_tool_gate", {
          p_lane: laneId,
          p_view: tool.requiredView,
          p_category: tool.category,
        });
        if (error || !data || typeof data !== "object" || Array.isArray(data)) return deny("gate_unavailable");
        const v = data as { allowed?: unknown; reason?: unknown; role?: unknown };
        if (v.allowed !== true) {
          const reason = typeof v.reason === "string" && GATE_REASONS.has(v.reason as DenyReason) ? (v.reason as DenyReason) : "gate_unavailable";
          return deny(reason);
        }
        if (typeof v.role !== "string" || !ROLES.has(v.role as Role)) return deny("role_denied");
        role = v.role as Role;
      } catch {
        return deny("gate_unavailable");
      }

      // Propose tools only for the user's explicit action: checked after the rate limit, so refusals count and are audited.
      if (tool.effect === "propose" && input.proposal?.toolName !== tool.name) return deny("propose_not_allowed");

      // 7. Strict arguments: unknown keys (a forged laneId included) fail. A throwing refinement counts as invalid.
      let args: unknown;
      try {
        const parsed = tool.args.safeParse(input.args);
        if (!parsed.success) return deny("invalid_args");
        args = parsed.data;
      } catch {
        return deny("invalid_args");
      }
      if (tool.effect === "propose") {
        let accepted = false;
        try {
          accepted = input.proposal?.check(args) === true;
        } catch {
          accepted = false;
        }
        if (!accepted) return deny("propose_not_allowed");
      }

      // 8. Run, audited before and after. No run without the requested entry.
      const entry = {
        laneId,
        actor: { kind: "user" as const, userId },
        target,
        metadata: { tool_use_id: toolUseId, category: tool.category, effect: tool.effect },
      };
      try {
        await deps.audit.log({ ...entry, action: "assistant.tool_call.requested" });
      } catch {
        return denyOut("tool_failed");
      }
      const started = now();
      let result: ToolResult<unknown>;
      try {
        const raw = await tool.run({ laneId, userId, role, client, ...(input.signal ? { signal: input.signal } : {}) }, args);
        // The envelope streams to the UI (sources, asOf, freshness): validate its shape.
        const env = toolResultSchema.safeParse(raw);
        if (!env.success) throw new Error("invalid tool result");
        result = raw;
      } catch {
        await deps.audit.log({ ...entry, action: "assistant.tool_call.failed" }).catch(() => undefined);
        return denyOut("tool_failed");
      }
      // The run happened: a failed final audit write must not hide that (a proposal may exist).
      const auditIncomplete = await deps.audit
        .log({ ...entry, action: "assistant.tool_call.succeeded" })
        .then(() => false)
        .catch(() => true);
      return { ok: true, tool, args, result, durationMs: now() - started, auditIncomplete };
    },
  };
}
