// The email handler of action.reconcile_stuck (T-192): Gmail marker lookup and read-back through the Google connector.
// Read-only (rule 4/5): it holds `GoogleEmailReconciler` (findWrite + verifyWrite), which has no executeWrite, and it
// reaches Gmail only through the connector (tokens stay in the Vault).
import { isConnectorError, type LaneBoundConnection } from "@nichols/connectors";
import { VERIFICATION_MISMATCH_MESSAGE, type GoogleEmailApprovedAction, type GoogleEmailReconciler } from "@nichols/connectors/write";
import type { LaneId } from "@nichols/core";
import type { ActionReconciler, ReconcileDecision } from "./reconcile";
import { EMAIL_ACTION_TYPES } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EmailReconcilerDeps = {
  reconciler: GoogleEmailReconciler;
  loadWriteConnection(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<"google">>;
};

const isMismatch = (e: unknown): boolean => isConnectorError(e) && e.info.message === VERIFICATION_MISMATCH_MESSAGE;

/** A connector failure as an undecided code (the action is looked at again until the give-up time). */
function undecidedOf(e: unknown): ReconcileDecision {
  if (isConnectorError(e)) {
    if (e.info.kind === "reconnect_required" || e.info.kind === "connection_unavailable") return { kind: "undecided", code: "reconcile_connection_unhealthy" };
    if (e.info.kind === "forbidden") return { kind: "undecided", code: "reconcile_scope_missing" };
    if (e.info.kind === "not_found") return { kind: "undecided", code: "reconcile_message_gone" };
    return { kind: "undecided", code: "reconcile_lookup_failed" };
  }
  return { kind: "undecided", code: "reconcile_lookup_failed" };
}

export function createEmailReconciler(deps: EmailReconcilerDeps): ActionReconciler {
  return {
    actionTypes: EMAIL_ACTION_TYPES,
    async decide({ laneId, row, claimOutcome, claimExternalId }) {
      if (typeof row.approvedBy !== "string" || !UUID.test(row.approvedBy)) return { kind: "failed", code: "reconcile_payload_changed", outcome: "outcome_unknown" };
      const action: GoogleEmailApprovedAction = {
        id: row.id,
        lane_id: laneId,
        connection_id: row.connectionId,
        action_type: row.actionType,
        target: row.target as GoogleEmailApprovedAction["target"],
        payload: row.payload as GoogleEmailApprovedAction["payload"],
        payload_schema_version: row.payloadSchemaVersion,
        payload_sha256: row.payloadSha256,
        approved_by: row.approvedBy,
      };
      let conn: LaneBoundConnection<"google">;
      try {
        conn = await deps.loadWriteConnection(laneId, row.connectionId);
      } catch (e) {
        const u = undecidedOf(e) as { kind: "undecided"; code: string };
        return claimOutcome === "sent" && claimExternalId !== null ? { ...u, sentUnverified: true } : u;
      }

      // 1. The claim says the send was accepted (outcome "sent") and holds the provider's id: read it back directly (no search lag).
      //    If the read-back cannot run, the mail was sent but not verified: undecided, then "sent, not read back" at give-up.
      if (claimOutcome === "sent" && claimExternalId !== null) {
        try {
          await deps.reconciler.verifyWrite(laneId, conn, action, claimExternalId);
          return { kind: "verified", externalId: claimExternalId, outcome: "accepted" };
        } catch (e) {
          if (isMismatch(e)) return { kind: "failed", code: "verification_mismatch", outcome: "mismatch" };
          return { ...(undecidedOf(e) as { kind: "undecided"; code: string }), sentUnverified: true };
        }
      }

      // 2. No id was recorded: look for the marker (Message-ID <portal-{id}@domain>; header X-Portal-Action-Id).
      let ids: string[];
      try {
        ids = await deps.reconciler.findWrite(laneId, conn, action);
      } catch (e) {
        return undecidedOf(e);
      }
      if (ids.length === 0) return { kind: "undecided", code: "marker_not_found" };

      const verified: string[] = [];
      let mismatches = 0;
      let trouble: unknown = null;
      for (const id of ids) {
        try {
          await deps.reconciler.verifyWrite(laneId, conn, action, id);
          verified.push(id);
        } catch (e) {
          if (isMismatch(e)) mismatches += 1;
          else trouble = e;
        }
      }
      if (verified.length === 1 && trouble === null) return { kind: "verified", externalId: verified[0] as string, outcome: "already_applied" };
      if (verified.length > 1) return { kind: "failed", code: "ambiguous_match", outcome: "outcome_unknown" };
      if (trouble !== null) return undecidedOf(trouble);
      return mismatches > 0 ? { kind: "failed", code: "verification_mismatch", outcome: "mismatch" } : { kind: "undecided", code: "marker_not_found" };
    },
  };
}
