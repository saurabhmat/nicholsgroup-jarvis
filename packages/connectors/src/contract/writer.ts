// Write side of the connector contract. Exposed only as the `@nichols/connectors/writer` subpath so that T-193 can
// lint-forbid importing it anywhere except `packages/modules/approvals` (rule 5, approvals spec §5).
// Not re-exported from the package root.
import type { LaneId } from "@nichols/core";
import type { Connection, ExecResult, JsonObject, Provider } from "./schemas";

/**
 * Minimum shape of an approved action as stored in `act.proposed_actions`. T-193 replaces the type argument with the
 * branded `ApprovedAction` that only `mintApprovedAction` can construct.
 */
export interface ApprovedActionShape {
  readonly id: string;
  readonly lane_id: LaneId;
  readonly connection_id: string;
  readonly action_type: string;
  readonly target: JsonObject;
  readonly payload: JsonObject;
  readonly payload_schema_version: number;
  readonly payload_sha256: string;
}

/**
 * Executes one approved action. Implementations must re-check the lane and connection, and recompute
 * `sha256(payload) === action.payload_sha256` before calling the provider (T-193).
 */
export interface ConnectorWriter<TAction extends ApprovedActionShape = ApprovedActionShape> {
  readonly provider: Provider;
  readonly actionTypes: readonly string[];
  executeWrite(laneId: LaneId, conn: Connection, action: TAction): Promise<ExecResult>;
}
