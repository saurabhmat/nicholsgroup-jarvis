// The qbo.disconnect handler of action.reconcile_stuck (T-195). Read-only: the verifier reads the connection row and asks the
// Vault whether a token is still handed out; it cannot revoke anything (it holds no `executeWrite`). A disconnect that was
// stuck `executing` (the request died after the revoke, or recording the result failed) is verified when the connection is
// `disconnected`; otherwise it stays undecided and, past the give-up time, ends failed / outcome_unknown for a person to look at.
import type { LaneBoundConnection } from "@nichols/connectors";
import { isConnectorError } from "@nichols/connectors";
import { QBO_VERIFICATION_MISMATCH_MESSAGE } from "@nichols/connectors/write";
import type { LaneId } from "@nichols/core";
import { qboExternalId, type QboExecDeps } from "./qbo";
import type { ActionReconciler } from "./reconcile";
import { QBO_DISCONNECT } from "./types";

export type QboReconcilerDeps = {
  verifier: QboExecDeps["verifier"];
  loadWriteConnection(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<"quickbooks">>;
};

export function createQboReconciler(deps: QboReconcilerDeps): ActionReconciler {
  return {
    actionTypes: [QBO_DISCONNECT],
    async decide({ laneId, row }) {
      let conn: LaneBoundConnection<"quickbooks">;
      try {
        conn = await deps.loadWriteConnection(laneId, row.connectionId);
      } catch {
        return { kind: "undecided", code: "reconcile_lookup_failed" };
      }
      try {
        await deps.verifier.verify(laneId, conn, { lane_id: laneId, connection_id: row.connectionId, target: row.target as never });
        return { kind: "verified", externalId: qboExternalId(row.connectionId), outcome: "accepted" };
      } catch (e) {
        if (isConnectorError(e) && e.info.message === QBO_VERIFICATION_MISMATCH_MESSAGE) return { kind: "undecided", code: "reconcile_not_disconnected" };
        return { kind: "undecided", code: "reconcile_lookup_failed" };
      }
    },
  };
}
