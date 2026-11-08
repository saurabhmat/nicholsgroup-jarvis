// Policy gate (T-101, docs/specs/assistant.md §3, §4): the only way a tool runs. Order:
//   1. AAL2 session                    guards.requireLane (no session / mfa required)
//   2. membership and role             requireLane (member of an enabled, served lane) + core.ai_tool_gate
//   3. lane enabled                    core.ai_tool_gate
//   4. llm_allowed_categories          core.ai_tool_gate
//   5. 'assistant' + required view     core.ai_tool_gate
//   6. rate limit                      core.ai_tool_gate (atomic, per lane and user)
//   7. strict argument parse           the descriptor's schema (a forged laneId or extra field fails here)
//   8. run + audit                     withAudit: requested -> succeeded | failed
// laneId comes from the server (the conversation), never from model output. Every call is audited, denied ones with
// the reason only (no argument values). Denials are returned as a structured outcome for the model; they never throw.
import { withAudit, type Audit } from "@nichols/core/audit";
import type { LaneId } from "@nichols/core";
import { AuthError, type Role } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import type { ToolDescriptor, ToolRegistry, ToolResult } from "./registry";

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
  | "tool_failed";

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
};

export type GateCall = { laneId: LaneId; toolName: string; toolUseId: string; args: unknown };

export type GateOutcome =
  | { ok: true; tool: ToolDescriptor; result: ToolResult<unknown> }
  | { ok: false; reason: DenyReason; message: string };

export type GateDeps = {
  registry: ToolRegistry;
  /** guards.requireLane from @nichols/core/auth: AAL2 session + membership of an enabled lane, user client. */
  requireLane(laneId: LaneId): Promise<{ session: { userId: string }; client: LaneClient }>;
  audit: Audit;
  /** Calls per user and lane per window. Default 30 per 60 s. */
  rateLimit?: { limit: number; windowSeconds: number };
};

export type PolicyGate = { call(input: GateCall): Promise<GateOutcome> };

const GATE_REASONS = new Set<DenyReason>(["mfa_required", "not_member", "role_denied", "lane_disabled", "category_denied", "view_denied", "rate_limited"]);
// Roles that hold the 'assistant' view (core.role_views). Checked again here so a wrong database answer cannot hand a
// viewer or admin_technical a content tool.
const ROLES = new Set<Role>(["owner", "finance_operator"]);
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,100}$/;

function authReason(e: unknown): DenyReason | null {
  if (!(e instanceof AuthError)) return null;
  if (e.reason === "no_session") return "no_session";
  if (e.reason === "mfa_required") return "mfa_required";
  return "not_member";
}

export function createPolicyGate(deps: GateDeps): PolicyGate {
  const limit = deps.rateLimit?.limit ?? 30;
  const windowSeconds = deps.rateLimit?.windowSeconds ?? 60;

  return {
    async call(input) {
      const { laneId } = input;
      const toolUseId = typeof input.toolUseId === "string" && TOOL_USE_ID.test(input.toolUseId) ? input.toolUseId : "invalid";
      const tool = typeof input.toolName === "string" ? deps.registry.get(input.toolName) : undefined;
      const target = tool ? `tool:${tool.name}` : "tool:unknown";
      let userId: string | null = null;

      const deny = async (reason: DenyReason): Promise<GateOutcome> => {
        // Audited with the reason only. A failed audit write must not turn a denial into an exception for the UI.
        await deps.audit
          .log({
            laneId,
            actor: userId ? { kind: "user", userId } : { kind: "system" },
            action: "assistant.tool_call.denied",
            target,
            metadata: { reason, tool_use_id: toolUseId, ...(tool ? { category: tool.category, effect: tool.effect } : {}) },
          })
          .catch(() => undefined);
        return { ok: false, reason, message: DENY_MESSAGES[reason] };
      };

      if (!tool) return deny("unknown_tool");

      // 1-2. Session at AAL2 and membership of an enabled lane (the lane router refuses everything else).
      let client: LaneClient;
      let uid: string;
      try {
        const ctx = await deps.requireLane(laneId);
        uid = ctx.session.userId;
        userId = uid;
        client = ctx.client;
      } catch (e) {
        return deny(authReason(e) ?? "gate_unavailable");
      }

      // 2-6. Role, lane enabled, category, views and rate limit, for this user, in the database.
      let role: Role;
      try {
        const { data, error } = await client.schema("core").rpc("ai_tool_gate", {
          p_lane: laneId,
          p_view: tool.requiredView,
          p_category: tool.category,
          p_limit: limit,
          p_window_seconds: windowSeconds,
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

      // 7. Strict arguments: unknown keys (a forged laneId included) fail.
      const parsed = tool.args.safeParse(input.args);
      if (!parsed.success) return deny("invalid_args");

      // 8. Run, audited before and after; an audit failure before the run means the tool never runs.
      const entry = {
        laneId,
        actor: { kind: "user" as const, userId: uid },
        action: "assistant.tool_call",
        target,
        metadata: { tool_use_id: toolUseId, category: tool.category, effect: tool.effect },
      };
      try {
        const result = await withAudit(deps.audit, entry, () => tool.run({ laneId, userId: uid, role }, parsed.data));
        return { ok: true, tool, result };
      } catch {
        return { ok: false, reason: "tool_failed", message: DENY_MESSAGES.tool_failed };
      }
    },
  };
}
