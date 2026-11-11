// action.reconcile_stuck (T-192; docs/specs/approvals.md §6): finishes actions left `executing` (the request died after the
// provider accepted the send, or recording the result failed). VERIFY-ONLY, by construction:
//   * the only database calls are act_stuck_actions (read), act_reconcile_verified and act_reconcile_failed (conditional
//     updates). It never calls act_claim_execution, so there is never a second claim; the claim of the original attempt
//     stays the only one (primary key on act.execution_claims).
//   * the handlers hold a read-only provider interface (marker lookup and read-back); they have no `executeWrite`, so
//     nothing can be sent or created from here, even by mistake.
// What a handler may conclude, and what the sweep does with it:
//   verified   the provider has exactly one message that matches the approved payload -> act_reconcile_verified.
//   failed     the provider holds a message that does NOT match, or several matches (ambiguous) -> failed, at once.
//   undecided  nothing found, lookup error, connection unhealthy or scope missing -> the action stays `executing` and is
//              looked at again on the next sweep; once it is older than the lane's give-up time (default 60 min) it ends
//              `failed` / `outcome_unknown` with a specific code, for a human to check the mailbox. NOT FOUND NEVER MEANS
//              "NOT SENT": Gmail search can lag, and the send may have been accepted before the crash. So the app never
//              records a plain, retry-safe failure from here, and never sends again.
// Concurrency: the SQL functions lock the row and change it only while it is still `executing` and due, so two sweeps, or a
// sweep racing a late-finishing execute, produce exactly one transition (the loser sees `false` and does nothing).
// Type-dispatched: a handler per action type (email now; monday.com plugs in later by adding a handler).
import type { LaneId } from "@nichols/core";
import type { Audit } from "@nichols/core/audit";
import { hashOfRow, toRow } from "./rows";
import { toApprovalsError } from "./errors";
import type { ActionRow, Rpc } from "./types";

/** What a handler concluded about one stuck action. Codes are `[a-z][a-z0-9_]{0,63}`. */
export type ReconcileDecision =
  | { kind: "verified"; externalId: string; outcome: "accepted" | "already_applied" }
  | { kind: "failed"; code: string; outcome: "mismatch" | "outcome_unknown" }
  /** `sentUnverified`: the claim recorded the provider's id (the send was accepted) but the read-back cannot run. */
  | { kind: "undecided"; code: string; sentUnverified?: true };

export type ReconcileInput = { laneId: LaneId; row: ActionRow; claimOutcome: string | null; claimExternalId: string | null };

export interface ActionReconciler {
  /** The action types this handler decides (exact `action_type` strings). */
  readonly actionTypes: readonly string[];
  /** Read-only. Must not throw for provider trouble in a way that hides it: return `undecided` with a code instead. */
  decide(input: ReconcileInput): Promise<ReconcileDecision>;
}

export type ReconcileDeps = {
  jobRpc(laneId: LaneId): Promise<Rpc>;
  audit: Audit;
  reconcilers: readonly ActionReconciler[];
};

export type ReconcileSummary = { lane: string; checked: number; verified: number; failed: number; undecided: number; unchanged: number; errors: number };

const LANE = /^[A-Z]{1,8}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Per sweep and lane. The rest wait for the next run (every 5 minutes). */
export const RECONCILE_BATCH = 20;

type StuckRow = { action: unknown; claim_outcome: string | null; claim_external_id: string | null; give_up: boolean };

function stuckRows(data: unknown): StuckRow[] {
  if (!Array.isArray(data)) throw new Error("reconcile: list unavailable");
  return data.filter((r): r is StuckRow => typeof r === "object" && r !== null && "action" in r);
}

/** One sweep of one lane. Never throws for a single action; throws only when the list itself cannot be read. */
export async function reconcileStuckActions(deps: ReconcileDeps, laneId: LaneId): Promise<ReconcileSummary> {
  if (typeof laneId !== "string" || !LANE.test(laneId)) throw new Error("reconcile: invalid lane");
  const summary: ReconcileSummary = { lane: laneId, checked: 0, verified: 0, failed: 0, undecided: 0, unchanged: 0, errors: 0 };
  const rpc = await deps.jobRpc(laneId);
  const listed = await rpc("act_stuck_actions", { p_lane: laneId, p_limit: RECONCILE_BATCH });
  if (listed.error) throw new Error("reconcile: list unavailable");

  for (const item of stuckRows(listed.data)) {
    summary.checked += 1;
    let actionId = "unknown";
    let actionType = "unknown";
    try {
      const row = toRow(item.action);
      actionId = row.id;
      actionType = row.actionType;
      // The list is for this lane only; anything else is refused here too (cross-lane defence in depth).
      if (row.laneId !== laneId || row.status !== "executing") {
        summary.unchanged += 1;
        continue;
      }
      const decision = await decide(deps, laneId, row, item.claim_outcome, item.claim_external_id);
      const applied = await apply(deps, rpc, laneId, row, decision, item.give_up);
      summary[applied] += 1;
    } catch (e) {
      summary.errors += 1;
      // Ids only: never a body, a token or a provider message.
      console.error("[approvals] reconcile failed for an action", { laneId, actionId, error: e instanceof Error ? e.name : "unknown" });
      // A row that keeps erroring must not keep its body and starve the batch forever (T-192 security L1): once it is past
      // the give-up time it ends failed / outcome_unknown, found by its raw id.
      if (item.give_up === true) {
        const raw = (item.action as { id?: unknown; action_type?: unknown } | null) ?? {};
        const rawId = typeof raw.id === "string" && UUID.test(raw.id) ? raw.id : null;
        if (rawId !== null) {
          try {
            const res = await rpc("act_reconcile_failed", { p_lane: laneId, p_id: rawId, p_code: "reconcile_error", p_outcome: "outcome_unknown" });
            if (!res.error && res.data === true) {
              summary.failed += 1;
              await auditTransition(deps, laneId, "action.failed", rawId, { by: "reconciler", reconciled: true, action_type: typeof raw.action_type === "string" ? raw.action_type : actionType, failure: "reconcile_error", outcome: "outcome_unknown" });
            }
          } catch {
            // Still logged above; the next sweep tries again.
          }
        }
      }
    }
  }
  return summary;
}

async function decide(deps: ReconcileDeps, laneId: LaneId, row: ActionRow, claimOutcome: string | null, claimExternalId: string | null): Promise<ReconcileDecision> {
  // The stored content must still be what was approved. If not, nothing here trusts it (the writer refused it, too).
  let intact = false;
  try {
    intact = hashOfRow(row) === row.payloadSha256 && row.approvedHash === row.payloadSha256;
  } catch {
    intact = false; // content that cannot even be canonicalised is not what was approved
  }
  if (!intact) return { kind: "failed", code: "reconcile_payload_changed", outcome: "outcome_unknown" };
  const handler = deps.reconcilers.find((r) => r.actionTypes.includes(row.actionType));
  if (!handler) return { kind: "undecided", code: "reconcile_unsupported" };
  try {
    const d = await handler.decide({ laneId, row, claimOutcome, claimExternalId });
    if (d.kind !== "verified" && !CODE.test(d.code)) return { kind: "undecided", code: "reconcile_error" };
    return d;
  } catch {
    // A handler that throws is treated as "could not decide", never as "nothing was sent".
    return { kind: "undecided", code: "reconcile_error" };
  }
}

async function apply(deps: ReconcileDeps, rpc: Rpc, laneId: LaneId, row: ActionRow, d: ReconcileDecision, giveUp: boolean): Promise<"verified" | "failed" | "undecided" | "unchanged"> {
  if (d.kind === "undecided") {
    if (!giveUp) return "undecided";
    // Sent but never read back: the claim keeps "sent" and the code says so (the owner is told to check the mailbox).
    return d.sentUnverified ? finishFailed(deps, rpc, laneId, row, "reconcile_sent_unverified", "sent") : finishFailed(deps, rpc, laneId, row, d.code, "outcome_unknown");
  }
  if (d.kind === "failed") return finishFailed(deps, rpc, laneId, row, d.code, d.outcome);
  const res = await rpc("act_reconcile_verified", { p_lane: laneId, p_id: row.id, p_external_id: d.externalId, p_outcome: d.outcome });
  if (res.error) throw toApprovalsError(res.error);
  // false: another sweep or the original execute finished it first. Nothing to do, nothing to audit twice.
  if (res.data !== true) return "unchanged";
  await auditTransition(deps, laneId, "action.verified", row.id, { by: "reconciler", reconciled: true, action_type: row.actionType, outcome: d.outcome, external_id: d.externalId });
  return "verified";
}

async function finishFailed(deps: ReconcileDeps, rpc: Rpc, laneId: LaneId, row: ActionRow, code: string, outcome: "mismatch" | "outcome_unknown" | "sent"): Promise<"failed" | "unchanged"> {
  const res = await rpc("act_reconcile_failed", { p_lane: laneId, p_id: row.id, p_code: code, p_outcome: outcome });
  if (res.error) throw toApprovalsError(res.error);
  if (res.data !== true) return "unchanged";
  await auditTransition(deps, laneId, "action.failed", row.id, { by: "reconciler", reconciled: true, action_type: row.actionType, failure: code, outcome });
  return "failed";
}

/** The transition is already recorded in act.status_history in the same statement; a failed audit write is logged, not retried into a second transition. */
async function auditTransition(deps: ReconcileDeps, laneId: LaneId, action: string, actionId: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    await deps.audit.log({ laneId, actor: { kind: "service" }, action, target: `action:${actionId}`, metadata });
  } catch {
    console.error("[approvals] reconcile transition could not be audited (it is in act.status_history)", { laneId, actionId });
  }
}
