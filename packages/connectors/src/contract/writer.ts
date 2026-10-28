// Write side of the connector contract. Exposed only as the `@nichols/connectors/writer` subpath so that T-193 can
// lint-forbid importing it anywhere except `packages/modules/approvals` (rule 5, approvals spec §5).
// Not re-exported from the package root.
import type { LaneId } from "@nichols/core";
import type { LaneBoundConnection } from "./lane-bound";
import type { ExecResult, JsonObject, Provider } from "./schemas";

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
 * Executes one approved action. Before calling the provider, every implementation must:
 * - `assertLaneBound(laneId, conn)` and re-read the authoritative connection row (lane, status) like any read;
 * - assert `action.lane_id === laneId` and `action.connection_id === conn.id`;
 * - recompute `payload_sha256` and compare: SHA-256 over the RFC 8785 (JCS) canonical JSON of
 *   `{lane_id, action_type, connection_id, target, payload, payload_schema_version}`, exactly as defined in
 *   `docs/specs/approvals.md` §4 (T-193).
 */
export interface ConnectorWriter<TAction extends ApprovedActionShape = ApprovedActionShape, P extends string = Provider> {
  readonly provider: P;
  readonly actionTypes: readonly string[];
  executeWrite(laneId: LaneId, conn: LaneBoundConnection<P>, action: TAction): Promise<ExecResult>;
}
