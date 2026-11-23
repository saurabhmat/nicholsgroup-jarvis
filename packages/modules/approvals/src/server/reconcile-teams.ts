// The Teams handler of action.reconcile_stuck (T-287; docs/specs/messages.md 10.4). Read-only (rule 4/5): it holds only `findWrite` + `verifyWrite` (the writer's reconciler read side has no
// `executeWrite`), so it can never post. A Teams send left `executing` (the request timed out and the lookup found nothing, the accepted message could not be read back yet, or the process died) is
// finished by the SAME lookup the writer uses: the person's own message in the same place, created after the claim, with the approved text.
//   claim says "sent" with the message id   -> read it back by id: verified; different text = failed verification_mismatch; not readable yet = undecided (sent, not read back).
//   no id recorded                          -> look up by date range: one match = verified `already_applied`; several = failed `ambiguous_match` (outcome_unknown); none = undecided.
//   undecided                               -> looked at again next sweep; at reconcile_give_up_minutes it ends failed / `outcome_unknown` ("Outcome unknown: check the chat in Teams before
//                                              sending again"). NOT FOUND NEVER MEANS "NOT SENT": there is no marker on a chat message, so the sweep never resends.
// The action's text is still held while it is `executing`, which is what the lookup compares with; it is purged with the terminal transition.
import { isConnectorError } from "@nichols/connectors";
import { teamsFailureCodeOf, teamsLookupWindow, type TeamsApprovedAction } from "@nichols/connectors/write";
import type { LaneId } from "@nichols/core";
import type { ActionReconciler, ReconcileDecision } from "./reconcile";
import { teamsActionOf } from "./teams";
import { TEAMS_ACTION_TYPES, type TeamsConn, type TeamsWriteSurface } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TeamsReconcilerDeps = {
  reconciler: Pick<TeamsWriteSurface, "findWrite" | "verifyWrite">;
  loadWriteConnection(laneId: LaneId, connectionId: string): Promise<TeamsConn>;
};

const isMismatch = (e: unknown): boolean => teamsFailureCodeOf(e) === "verification_mismatch";

/** A connector failure as an undecided code (the action is looked at again until the give-up time). Codes only, never a message. */
function undecidedOf(e: unknown): { kind: "undecided"; code: string } {
  if (isConnectorError(e)) {
    if (e.info.kind === "reconnect_required" || e.info.kind === "connection_unavailable") return { kind: "undecided", code: "reconcile_connection_unhealthy" };
    if (e.info.kind === "forbidden") return { kind: "undecided", code: "reconcile_scope_missing" };
    if (e.info.kind === "not_found") return { kind: "undecided", code: "reconcile_message_gone" };
    if (e.info.kind === "rate_limited") return { kind: "undecided", code: "reconcile_rate_limited" };
  }
  return { kind: "undecided", code: "reconcile_lookup_failed" };
}

export function createTeamsReconciler(deps: TeamsReconcilerDeps): ActionReconciler {
  return {
    actionTypes: TEAMS_ACTION_TYPES,
    async decide({ laneId, row, claimOutcome, claimExternalId }): Promise<ReconcileDecision> {
      if (typeof row.approvedBy !== "string" || !UUID.test(row.approvedBy)) return { kind: "failed", code: "reconcile_payload_changed", outcome: "outcome_unknown" };
      const action: TeamsApprovedAction = teamsActionOf(laneId, row, row.approvedBy);
      const window = teamsLookupWindow(row.executingAt);
      let conn: TeamsConn;
      try {
        conn = await deps.loadWriteConnection(laneId, row.connectionId);
      } catch (e) {
        // A connection row that is gone is not "the message is gone": its own code.
        const u = isConnectorError(e) && e.info.kind === "not_found" ? { kind: "undecided" as const, code: "reconcile_connection_missing" } : undecidedOf(e);
        return claimOutcome === "sent" && claimExternalId !== null ? { ...u, sentUnverified: true } : u;
      }

      // 1. The claim says the message was accepted and holds its id: read it back directly (no search lag).
      if (claimOutcome === "sent" && claimExternalId !== null) {
        try {
          await deps.reconciler.verifyWrite(laneId, conn, action, claimExternalId, window);
          return { kind: "verified", externalId: claimExternalId, outcome: "accepted" };
        } catch (e) {
          if (isMismatch(e)) return { kind: "failed", code: "verification_mismatch", outcome: "mismatch" };
          return { ...undecidedOf(e), sentUnverified: true };
        }
      }

      // 2. No id was recorded: look for the person's own message with the approved text since the claim.
      let ids: string[];
      try {
        ids = await deps.reconciler.findWrite(laneId, conn, action, window);
      } catch (e) {
        return undecidedOf(e);
      }
      if (ids.length === 0) return { kind: "undecided", code: "outcome_unknown" }; // the page says: check the chat in Teams before sending again
      if (ids.length > 1) return { kind: "failed", code: "ambiguous_match", outcome: "outcome_unknown" };
      try {
        await deps.reconciler.verifyWrite(laneId, conn, action, ids[0] as string, window);
        return { kind: "verified", externalId: ids[0] as string, outcome: "already_applied" };
      } catch (e) {
        if (isMismatch(e)) return { kind: "failed", code: "verification_mismatch", outcome: "mismatch" };
        return undecidedOf(e);
      }
    },
  };
}

